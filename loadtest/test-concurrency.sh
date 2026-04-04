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
#   --base-url URL    Run auth burst only against a live backend URL
#   --help            Show this help message

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m' # No Color

# Spinner animation
SPINNER='⣷⣯⣟⡿⢿⣻⣽⣾'
SPINNER_IDX=0

# Configuration
SKIP_SETUP=false
SKIP_BACKEND=false
SKIP_WEB=false
LEAVE_BACKEND=false
SKIP_CLEANUP=false
CONCURRENCY=100
BASE_URL=""
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_ROOT="$( dirname "$SCRIPT_DIR" )"
BACKEND_PID=""
WEB_PID=""
STARTED_BACKEND=false
STARTED_WEB=false
AUTH_ONLY=false
TEST_START_TIME=""
LOG_FILE="$SCRIPT_DIR/test-run-$(date +%Y%m%d-%H%M%S).log"
WEB_PORT=3001
WEB_BASE_URL="http://127.0.0.1:$WEB_PORT"

# Initialize log file
echo "# Concurrency Test Run - $(date)" > "$LOG_FILE"
echo "# Log file: $LOG_FILE" >> "$LOG_FILE"
echo "" >> "$LOG_FILE"

cleanup_backend() {
  if [ "$STARTED_BACKEND" = true ] && [ "$LEAVE_BACKEND" = false ] && [ -n "$BACKEND_PID" ]; then
    log_info "Stopping backend (pid=$BACKEND_PID)..."
    kill "$BACKEND_PID" 2>/dev/null || true
    wait "$BACKEND_PID" 2>/dev/null || true
    STARTED_BACKEND=false
  fi
}

cleanup_web() {
  if [ "$STARTED_WEB" = true ] && [ -n "$WEB_PID" ]; then
    log_info "Stopping web server (pid=$WEB_PID)..."
    kill "$WEB_PID" 2>/dev/null || true
    wait "$WEB_PID" 2>/dev/null || true
    STARTED_WEB=false
  fi
}

cleanup_all() {
  cleanup_web
  cleanup_backend
}

trap cleanup_all EXIT

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
    --skip-web)
      SKIP_WEB=true
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
    --base-url)
      BASE_URL="$2"
      AUTH_ONLY=true
      shift 2
      ;;
    --help)
      cat <<'EOF'
Usage: ./test-concurrency.sh [options]

Options:
  --skip-setup      Skip Docker setup (assume services already running)
  --skip-backend    Skip starting backend (assume already running on :8080)
  --skip-web        Skip web tests (Vitest + Playwright)
  --leave-backend   Don't stop backend started by this script
  --skip-cleanup    Don't clean up Docker containers after tests
  --concurrency N   Set concurrency level (default: 100)
  --base-url URL    Run auth burst only against a live backend URL
  --help            Show this help message
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if [ "$AUTH_ONLY" = true ] && [ -z "$BASE_URL" ]; then
  BASE_URL="http://localhost:8080"
fi

if [ "$AUTH_ONLY" = true ]; then
  log_info "Auth-only mode enabled (base-url=$BASE_URL)"
fi

# ========================================
# UI & Logging Functions
# ========================================

show_spinner() {
  local msg="$1"
  printf "\r  ${CYAN}${SPINNER:$SPINNER_IDX:1}${NC} ${msg}"
  SPINNER_IDX=$(( (SPINNER_IDX + 1) % 8 ))
}

hide_spinner() {
  printf "\r\033[K"
}

log_step() {
  local step_num="$1"
  local total_steps="$2"
  local msg="$3"
  echo ""
  echo -e "${BOLD}${BLUE}┌─────────────────────────────────────────────────${NC}"
  echo -e "${BOLD}${BLUE}│${NC} ${BOLD}Step $step_num/$total_steps:${NC} $msg"
  echo -e "${BOLD}${BLUE}└─────────────────────────────────────────────────${NC}"
  echo ""
  log_to_file "STEP $step_num/$total_steps: $msg"
}

log_info() {
  local msg="$1"
  echo -e "  ${CYAN}ℹ${NC} $msg"
  log_to_file "INFO: $msg"
}

log_success() {
  local msg="$1"
  echo -e "  ${GREEN}✓${NC} ${GREEN}$msg${NC}"
  log_to_file "PASS: $msg"
}

log_warn() {
  local msg="$1"
  echo -e "  ${YELLOW}⚠${NC} ${YELLOW}$msg${NC}"
  log_to_file "WARN: $msg"
}

log_error() {
  local msg="$1"
  echo -e "  ${RED}✗${NC} ${RED}$msg${NC}"
  log_to_file "FAIL: $msg"
}

log_to_file() {
  local timestamp
  timestamp=$(date '+%H:%M:%S')
  echo "[$timestamp] $1" >> "$LOG_FILE"
}

show_header() {
  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${CYAN}║${NC}  ${BOLD}Concurrency Test Suite Runner${NC}                      ${CYAN}║${NC}"
  echo -e "${BOLD}${CYAN}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${DIM}Concurrency Level:${NC} ${BOLD}$CONCURRENCY${NC}"
  echo -e "  ${DIM}Log File:${NC} $LOG_FILE"
  echo -e "  ${DIM}Started:${NC} $(date '+%H:%M:%S')"
  echo ""
  TEST_START_TIME=$(date +%s)
}

show_summary() {
  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - TEST_START_TIME))
  local minutes=$((duration / 60))
  local seconds=$((duration % 60))

  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${GREEN}║${NC}  ${BOLD}${GREEN}✓ All Tests Completed Successfully!${NC}                  ${GREEN}║${NC}"
  echo -e "${BOLD}${GREEN}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${DIM}Total Duration:${NC} ${BOLD}${minutes}m ${seconds}s${NC}"
  echo -e "  ${DIM}Log File:${NC} $LOG_FILE"
  echo ""
}

show_failure_summary() {
  local end_time
  end_time=$(date +%s)
  local duration=$((end_time - TEST_START_TIME))
  local minutes=$((duration / 60))
  local seconds=$((duration % 60))

  echo ""
  echo -e "${BOLD}${CYAN}╔══════════════════════════════════════════════════════════╗${NC}"
  echo -e "${BOLD}${RED}║${NC}  ${BOLD}${RED}✗ Test Suite Failed${NC}                                  ${RED}║${NC}"
  echo -e "${BOLD}${RED}╚══════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "  ${DIM}Duration:${NC} ${BOLD}${minutes}m ${seconds}s${NC}"
  echo -e "  ${DIM}Log File:${NC} $LOG_FILE"
  echo -e "  ${DIM}Check logs above or in:${NC} $LOG_FILE"
  echo ""
}

waiting_with_dots() {
  local msg="$1"
  local start_time
  start_time=$(date +%s)
  local dots=""
  
  while true; do
    dots="${dots}."
    if [ ${#dots} -gt 6 ]; then
      dots=""
    fi
    local now
    now=$(date +%s)
    local elapsed=$((now - start_time))
    # Write the spinner to stderr so it does not pollute normal stdout logs.
    printf "\r  ${CYAN}⣾${NC} ${msg}${dots} (${elapsed}s)" >&2
    sleep 1
  done &
  SPINNER_PID=$!
}

stop_waiting_animation() {
  local spinner_pid="$1"
  kill "$spinner_pid" 2>/dev/null || true
  wait "$spinner_pid" 2>/dev/null || true
  hide_spinner
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

# Show header
show_header

# Check prerequisites
log_step 1 9 "Checking prerequisites"
check_command node
if [ "$AUTH_ONLY" = false ]; then
  check_command pnpm
  check_command cargo
  if ! command -v docker-compose &> /dev/null && ! command -v docker &> /dev/null; then
    log_error "Docker (or docker-compose) is required but not installed"
    show_failure_summary
    exit 1
  fi
  log_success "All prerequisites met (node, pnpm, cargo, docker)"
fi

if [ "$AUTH_ONLY" = true ]; then
  cd "$SCRIPT_DIR"

  if [ ! -d node_modules ]; then
    log_info "Installing Node dependencies..."
    npm install --silent
  fi

  log_step 2 2 "Running Ably auth burst test (prod-safe mode)"
  : "${ABLY_API_KEY:?ABLY_API_KEY is required for auth-only mode}"
  node run-auth-burst-test.js --concurrency "$CONCURRENCY" --base-url "$BASE_URL" || {
    log_error "Ably auth burst test failed"
    show_failure_summary
    exit 1
  }

  log_success "Ably auth burst test passed"
  log_success "Prod-safe run completed"
  show_summary
  exit 0
fi

cd "$SCRIPT_DIR"

# Setup infrastructure
if [ "$SKIP_SETUP" = false ]; then
  log_step 2 9 "Starting test infrastructure (Docker)"

  # Build and start only the infra required for host-run tests.
  # (Avoid building the optional test-runner image, which is not used by this script.)
  log_info "Starting MySQL and Ably stub containers..."
  docker_compose -f "$PROJECT_ROOT/docker-compose.test.yml" up -d --build mysql-test ably-stub

  # Wait for MySQL to be healthy
  log_info "Waiting for MySQL to be ready..."
  waiting_with_dots "Connecting to MySQL"
  for i in {1..30}; do
    # `mysqladmin ping` can return confusing exit codes during init; prefer a real query.
    if docker exec classcolab-test-mysql mysql -h 127.0.0.1 -P 3306 -u classcolab -ptestpassword classcolab_test -e "SELECT 1" &> /dev/null; then
      stop_waiting_animation "$SPINNER_PID"
      printf "\n"
      log_success "MySQL is ready (attempt $i)"
      break
    fi
    if [ $i -eq 30 ]; then
      stop_waiting_animation "$SPINNER_PID"
      printf "\n"
      log_error "MySQL failed to start after 60s"
      log_info "Last 50 lines of MySQL logs:"
      docker logs classcolab-test-mysql --tail 50
      show_failure_summary
      exit 1
    fi
    sleep 2
  done

  # Wait for Ably stub to be healthy
  log_info "Waiting for Ably stub to be ready..."
  waiting_with_dots "Connecting to Ably stub"
  for i in {1..30}; do
    if curl -s http://localhost:8081/health &> /dev/null; then
      stop_waiting_animation "$SPINNER_PID"
      printf "\n"
      log_success "Ably stub is ready (attempt $i)"
      break
    fi
    if [ $i -eq 30 ]; then
      stop_waiting_animation "$SPINNER_PID"
      printf "\n"
      log_error "Ably stub failed to start after 30s"
      docker logs classcolab-test-ably-stub --tail 50
      show_failure_summary
      exit 1
    fi
    sleep 1
  done

  # Install Node dependencies
  log_info "Installing Node dependencies..."
  npm install --silent
  log_success "Infrastructure ready"

  # Ably stub runs in Docker; no local install needed.
else
  log_step 2 9 "Skipping setup (assuming services already running)"
  log_warn "Skipping Docker setup - assuming services already running"
fi

# Run migrations
log_step 3 9 "Running database migrations"
cd "$PROJECT_ROOT/apps/backend"

export DATABASE_URL="mysql://classcolab:testpassword@localhost:3307/classcolab_test"
export ABLY_API_KEY="test.key:secret"
export ABLY_REST_URL="http://localhost:8081"
# The slide create idempotency test fans out 15 concurrent requests and each
# request can hold a transaction open while waiting on the session lock.
# Give the test backend a larger connection pool so it does not fail by
# starving at the pool boundary before it reaches the write path.
export DB_MAX_CONNECTIONS="${DB_MAX_CONNECTIONS:-20}"
export DB_ACQUIRE_TIMEOUT_SECONDS="${DB_ACQUIRE_TIMEOUT_SECONDS:-60}"

# Apply all migrations
migration_count=0
for migration in $(ls migrations/*.sql | sort); do
  migration_count=$((migration_count + 1))
  log_info "  [$migration_count] Applying $(basename $migration)..."
  ./run_migration.sh "$(basename $migration)" || {
    log_error "Migration failed: $migration"
    show_failure_summary
    exit 1
  }
done

log_success "Migrations complete ($migration_count migrations applied)"

# Run Rust unit tests
log_step 4 9 "Running Rust unit tests"
cargo test --quiet || {
  log_error "Rust unit tests failed"
  show_failure_summary
  exit 1
}
log_success "Rust unit tests passed"

# Run web participant-ID checks before backend boot so failures short-circuit early.
if [ "$SKIP_WEB" = false ]; then
  log_step 5 9 "Running web participant-id Vitest"
  cd "$PROJECT_ROOT/apps/web"
  pnpm exec vitest run src/lib/participant-id.test.ts || {
    log_error "Web participant-id Vitest failed"
    show_failure_summary
    exit 1
  }
  log_success "Web participant-id Vitest passed"

  log_info "Starting web server for Playwright on $WEB_BASE_URL ..."
  (cd "$PROJECT_ROOT/apps/web" && PORT="$WEB_PORT" NEXT_PUBLIC_API_URL="http://localhost:8080/api" NEXT_PUBLIC_DISABLE_ABLY="1" npm run dev > "$SCRIPT_DIR/web-test.log" 2>&1) &
  WEB_PID=$!
  STARTED_WEB=true

  log_info "Waiting for web server to be ready..."
  waiting_with_dots "Connecting to web server"
  for i in {1..60}; do
    if curl -fsS --max-time 5 "$WEB_BASE_URL" > /dev/null 2>&1; then
      stop_waiting_animation "$SPINNER_PID"
      printf "\n"
      log_success "Web server is ready (attempt $i)"
      break
    fi
    if [ $i -eq 60 ]; then
      stop_waiting_animation "$SPINNER_PID"
      printf "\n"
      log_error "Web server failed to become ready after 120s"
      log_info "Last 50 lines of web-test.log:"
      tail -50 "$SCRIPT_DIR/web-test.log" || true
      show_failure_summary
      exit 1
    fi
    sleep 2
  done

  log_step 6 9 "Running browser participant-id smoke test (Playwright)"
  log_info "This test launches 100 browser contexts and may take 1-3 minutes..."
  PLAYWRIGHT_BASE_URL="$WEB_BASE_URL" PLAYWRIGHT_USE_WEB_SERVER=0 pnpm exec playwright test e2e/participant-id.spec.ts --project=chromium --reporter=line || {
    log_error "Browser participant-id smoke test failed"
    show_failure_summary
    exit 1
  }
  log_success "Browser participant-id smoke test passed"
else
  log_step 5 7 "Skipping web tests (--skip-web)"
  log_warn "Skipping Vitest and Playwright tests"
fi

# Ensure backend server is running (needed by node-based concurrency tests)
if [ "$SKIP_BACKEND" = false ]; then
  if [ "$SKIP_WEB" = false ]; then
    log_step 7 9 "Starting backend server"
  else
    log_step 6 7 "Starting backend server"
  fi
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
    log_info "Waiting for backend to be ready..."
    waiting_with_dots "Compiling and starting backend"
    for i in {1..60}; do
      if curl -fsS http://localhost:8080/health/ready > /dev/null 2>&1; then
        stop_waiting_animation "$SPINNER_PID"
        printf "\n"
        log_success "Backend is ready (attempt $i)"
        break
      fi
      if [ $i -eq 60 ]; then
        stop_waiting_animation "$SPINNER_PID"
        printf "\n"
        log_error "Backend failed to become ready after 60s"
        log_info "Last 50 lines of backend-test.log:"
        tail -50 "$SCRIPT_DIR/backend-test.log" || true
        show_failure_summary
        exit 1
      fi
      sleep 1
    done

    cd "$SCRIPT_DIR"
  fi
else
  if [ "$SKIP_WEB" = false ]; then
    log_step 7 9 "Skipping backend start (assuming backend already running)"
  else
    log_step 6 7 "Skipping backend start (assuming backend already running)"
  fi
  log_warn "Skipping backend start - assuming it's already running"
fi

# Run concurrency tests
if [ "$SKIP_WEB" = false ]; then
  log_step 8 9 "Running backend slide autosave/reorder regression test"
else
  log_step 7 7 "Running backend slide autosave/reorder regression test"
fi

cd "$PROJECT_ROOT/apps/backend"
cargo test --test concurrency t10_slide_autosave_and_reorder_are_serialized -- --ignored --test-threads=1 || {
  log_error "Backend slide autosave/reorder regression test failed"
  show_failure_summary
  exit 1
}
log_success "Backend slide autosave/reorder regression test passed"

cd "$SCRIPT_DIR"

if [ "$SKIP_WEB" = false ]; then
  log_step 9 9 "Running Ably concurrency tests (concurrency=$CONCURRENCY)"
else
  log_info "Running Ably concurrency tests (concurrency=$CONCURRENCY)"
fi

log_info "Running Ably auth burst test..."
node run-auth-burst-test.js --concurrency "$CONCURRENCY" || {
  log_error "Ably auth burst test failed"
  show_failure_summary
  exit 1
}
log_success "Ably auth burst test passed"

log_info "Running main concurrency tests..."
node run-concurrency-tests.js --concurrency=$CONCURRENCY || {
  log_error "Concurrency tests failed"

  # Show logs for debugging
  log_info "Fetching container logs..."
  docker logs classcolab-test-mysql --tail 100
  docker logs classcolab-test-ably-stub --tail 100
  
  show_failure_summary
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
  log_warn "Docker containers will remain running"
fi

# Show success summary
show_summary
exit 0
