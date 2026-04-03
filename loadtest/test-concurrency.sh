#!/bin/bash
# Concurrency Test Suite Runner
# 
# This script orchestrates the full concurrency test suite:
# 1. Starts Docker infrastructure (MySQL, Ably stub)
# 2. Runs database migrations
# 3. Executes all concurrency tests
# 4. Cleans up resources
#
# Usage: ./test-concurrency.sh [options]
#
# Options:
#   --skip-setup      Skip Docker setup (assume services already running)
#   --skip-backend    Skip starting backend (assume already running on :8080)
#   --leave-backend   Don't stop backend started by this script
#   --skip-cleanup    Don't clean up Docker containers after tests
#   --concurrency N   Set concurrency level (default: 100)
#   --help            Show this help message

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
SKIP_SETUP=false
SKIP_BACKEND=false
LEAVE_BACKEND=false
SKIP_CLEANUP=false
CONCURRENCY=100
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( dirname "$SCRIPT_DIR" )"
BACKEND_PID=""
STARTED_BACKEND=false

cleanup_backend() {
  if [ "$STARTED_BACKEND" = true ] && [ "$LEAVE_BACKEND" = false ] && [ -n "$BACKEND_PID" ]; then
    echo "[INFO] Stopping backend (pid=$BACKEND_PID)..."
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    STARTED_BACKEND=false
  fi
}

trap cleanup_backend EXIT

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --skip-setup)
      SKIP_SETUP=true
      shift
      ;;
    --skip-backend)
      SKIP_BACKEND=true
      shift
      ;;
    --leave-backend)
      LEAVE_BACKEND=true
      shift
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --concurrency)
      CONCURRENCY="$2"
      shift 2
      ;;
    --help)
      head -20 "$0" | tail -15
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Helper functions
log_info() {
  echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
  echo -e "${GREEN}[PASS]${NC} $1"
}

log_warn() {
  echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
  echo -e "${RED}[FAIL]${NC} $1"
}

check_command() {
  if ! command -v "$1" &> /dev/null; then
    log_error "$1 is required but not installed"
    exit 1
  fi
}

# Determine whether to use `docker compose` or `docker-compose`
docker_compose() {
  if command -v docker-compose &> /dev/null; then
    docker-compose "$@"
    return
  fi
  if command -v docker &> /dev/null; then
    docker compose "$@"
    return
  fi
  log_error "Docker is required but not installed"
  exit 1
}

# Check prerequisites
log_info "Checking prerequisites..."
check_command node
check_command pnpm
check_command cargo
if ! command -v docker-compose &> /dev/null && ! command -v docker &> /dev/null; then
  log_error "Docker (or docker-compose) is required but not installed"
  exit 1
fi

cd "$SCRIPT_DIR"

# Setup infrastructure
if [ "$SKIP_SETUP" = false ]; then
  log_info "Starting test infrastructure..."
  
  # Build and start only the infra required for host-run tests.
  # (Avoid building the optional test-runner image, which is not used by this script.)
  docker_compose -f "$PROJECT_ROOT/docker-compose.test.yml" up -d --build mysql-test ably-stub
  
  # Wait for MySQL to be healthy
  log_info "Waiting for MySQL to be ready..."
  for i in {1..30}; do
    # `mysqladmin ping` can return confusing exit codes during init; prefer a real query.
    if docker exec classcolab-test-mysql mysql -h 127.0.0.1 -P 3306 -u classcolab -ptestpassword classcolab_test -e "SELECT 1" &> /dev/null; then
      log_success "MySQL is ready"
      break
    fi
    if [ $i -eq 30 ]; then
      log_error "MySQL failed to start"
      docker logs classcolab-test-mysql
      exit 1
    fi
    sleep 2
  done
  
  # Wait for Ably stub to be healthy
  log_info "Waiting for Ably stub to be ready..."
  for i in {1..30}; do
    if curl -s http://localhost:8081/health &> /dev/null; then
      log_success "Ably stub is ready"
      break
    fi
    if [ $i -eq 30 ]; then
      log_error "Ably stub failed to start"
      docker logs classcolab-test-ably-stub
      exit 1
    fi
    sleep 1
  done
  
  # Install Node dependencies
  log_info "Installing Node dependencies..."
  npm install --silent
  
  # Ably stub runs in Docker; no local install needed.
else
  log_info "Skipping setup (assuming services already running)"
fi

# Run migrations
log_info "Running database migrations..."
cd "$PROJECT_ROOT/apps/backend"

export DATABASE_URL="mysql://classcolab:testpassword@localhost:3307/classcolab_test"
export ABLY_API_KEY="test.key:secret"
export ABLY_REST_URL="http://localhost:8081"

# Apply all migrations
for migration in $(ls migrations/*.sql | sort); do
  log_info "  Applying $(basename $migration)..."
  ./run_migration.sh "$(basename $migration)" || {
    log_error "Migration failed: $migration"
    exit 1
  }
done

log_success "Migrations complete"

# Run Rust unit tests
log_info "Running Rust unit tests..."
cargo test --quiet || {
  log_error "Rust unit tests failed"
  exit 1
}
log_success "Rust unit tests passed"

# Run web participant-ID checks before backend boot so failures short-circuit early.
log_info "Running web participant-id Vitest..."
cd "$PROJECT_ROOT/apps/web"
pnpm exec vitest run src/lib/participant-id.test.ts || {
  log_error "Web participant-id Vitest failed"
  exit 1
}
log_success "Web participant-id Vitest passed"

log_info "Running browser participant-id smoke..."
pnpm exec playwright test e2e/participant-id.spec.ts --project=chromium || {
  log_error "Browser participant-id smoke failed"
  exit 1
}
log_success "Browser participant-id smoke passed"

# Ensure backend server is running (needed by node-based concurrency tests)
if [ "$SKIP_BACKEND" = false ]; then
  log_info "Checking backend readiness..."
  if curl -fsS http://localhost:8080/health/ready > /dev/null 2>&1; then
    log_success "Backend is already running"
  else
    log_info "Starting backend (apps/backend) ..."
    cd "$PROJECT_ROOT/apps/backend"

    # Start backend in background with the same test env
    (cargo run > "$SCRIPT_DIR/backend-test.log" 2>&1) &
    BACKEND_PID=$!
    STARTED_BACKEND=true

    # Wait for backend to be ready
    for i in {1..60}; do
      if curl -fsS http://localhost:8080/health/ready > /dev/null 2>&1; then
        log_success "Backend is ready"
        break
      fi
      if [ $i -eq 60 ]; then
        log_error "Backend failed to become ready"
        log_info "Last 200 lines of backend-test.log:"
        tail -200 "$SCRIPT_DIR/backend-test.log" || true
        exit 1
      fi
      sleep 1
    done

    cd "$SCRIPT_DIR"
  fi
else
  log_info "Skipping backend start (assuming backend already running)"
fi

# Run concurrency tests
log_info "Running concurrency tests (concurrency=$CONCURRENCY)..."
cd "$SCRIPT_DIR"

log_info "Running Ably auth burst test (concurrency=$CONCURRENCY)..."
node run-auth-burst-test.js --concurrency "$CONCURRENCY" || {
  log_error "Ably auth burst test failed"
  exit 1
}
log_success "Ably auth burst test passed"

node run-concurrency-tests.js --concurrency=$CONCURRENCY || {
  log_error "Concurrency tests failed"
  
  # Show logs for debugging
  log_info "Fetching container logs..."
  docker logs classcolab-test-mysql --tail 100
  docker logs classcolab-test-ably-stub --tail 100
  
  exit 1
}

log_success "All concurrency tests passed!"

# Stop backend if we started it (also runs via trap on early exit)
if [ "$STARTED_BACKEND" = true ] && [ "$LEAVE_BACKEND" = false ]; then
  cleanup_backend
  log_success "Backend stopped"
fi

# Cleanup
if [ "$SKIP_CLEANUP" = false ]; then
  log_info "Cleaning up test infrastructure..."
  docker_compose -f "$PROJECT_ROOT/docker-compose.test.yml" down -v
  log_success "Cleanup complete"
else
  log_info "Skipping cleanup (containers left running)"
fi

log_success "All tests completed successfully!"
exit 0
