#!/bin/bash
set -euo pipefail

# Quick Start: Speed Audit Test Suite
# Runs all speed audit tests in sequence for production validation
#
# Usage: ./run-all-speed-audit-tests.sh [options]
#
# This script orchestrates:
# 1. Functional test (validates all 9 audit log points)
# 2. Load test (stress tests under concurrency)
# 3. Log analysis (deep-dive into timing metrics)
#
# All results are written to a timestamped output directory

BASE_URL="${BASE_URL:-}"
PERF_TEST_TOKEN_VALUE="${PERF_TEST_TOKEN:-}"
CONCURRENCY="${CONCURRENCY:-100}"
DURATION="${DURATION:-5m}"
LOG_FILE="${LOG_FILE:-}"
OUTPUT_DIR="${OUTPUT_DIR:-}"
SKIP_CLEANUP="${SKIP_CLEANUP:-false}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --perf-test-token)
      PERF_TEST_TOKEN_VALUE="$2"
      shift 2
      ;;
    --concurrency)
      CONCURRENCY="$2"
      shift 2
      ;;
    --duration)
      DURATION="$2"
      shift 2
      ;;
    --log-file)
      LOG_FILE="$2"
      shift 2
      ;;
    --output-dir)
      OUTPUT_DIR="$2"
      shift 2
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: ./run-all-speed-audit-tests.sh [options]

Run all speed audit tests in sequence for comprehensive production validation.

Options:
  --base-url URL        Backend API URL (required)
  --perf-test-token T   Token for cleanup (required unless --skip-cleanup)
  --concurrency N       Load test concurrency (default: 100)
  --duration DURATION   Load test duration (default: 5m)
  --log-file PATH       Backend log file (required for log analysis)
  --output-dir DIR      Output directory (default: ./speed-audit-results-TIMESTAMP)
  --skip-cleanup        Leave test sessions in place
  --help                Show this help message

Environment variables:
  BASE_URL
  PERF_TEST_TOKEN
  CONCURRENCY
  DURATION
  LOG_FILE
  SKIP_CLEANUP

Example:
  ./run-all-speed-audit-tests.sh \
    --base-url https://class-collaboration-production.up.railway.app \
    --perf-test-token $PERF_TEST_TOKEN \
    --concurrency 100 \
    --duration 5m \
    --log-file /var/log/backend.log

Output:
  Creates a timestamped directory with:
  - functional-summary.json
  - load-summary.json
  - audit-report.json
  - test-output.log (complete test output)
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BASE_URL" ]]; then
  echo "ERROR: BASE_URL is required. Pass --base-url or export BASE_URL." >&2
  exit 1
fi

if [[ "$SKIP_CLEANUP" == false && -z "$PERF_TEST_TOKEN_VALUE" ]]; then
  echo "ERROR: PERF_TEST_TOKEN is required unless --skip-cleanup is set" >&2
  exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

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

# Setup output directory
if [[ -z "$OUTPUT_DIR" ]]; then
  OUTPUT_DIR="./speed-audit-results-$(date +%Y%m%d-%H%M%S)"
fi

mkdir -p "$OUTPUT_DIR"

echo ""
echo "========================================================================"
echo "  Speed Audit Test Suite - Full Validation"
echo "========================================================================"
echo ""
log_info "Base URL: $BASE_URL"
log_info "Concurrency: $CONCURRENCY"
log_info "Duration: $DURATION"
log_info "Output Directory: $OUTPUT_DIR"
log_info "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Track overall results
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Step 1: Functional Test
echo ""
echo "========================================================================"
echo "  Step 1/3: Functional Test"
echo "========================================================================"
echo ""

TESTS_RUN=$((TESTS_RUN + 1))

functional_log="$OUTPUT_DIR/functional-test.log"
functional_summary="$OUTPUT_DIR/functional-summary.json"

if ./test-speed-audit-logs.sh \
  --base-url "$BASE_URL" \
  --perf-test-token "$PERF_TEST_TOKEN_VALUE" \
  ${LOG_FILE:+--log-file "$LOG_FILE"} \
  --summary-file "$functional_summary" \
  --skip-cleanup \
  2>&1 | tee "$functional_log"; then
  
  log_success "Functional test completed"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  log_error "Functional test failed (check $functional_log)"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

echo ""

# Step 2: Load Test
echo ""
echo "========================================================================"
echo "  Step 2/3: Load Test"
echo "========================================================================"
echo ""

TESTS_RUN=$((TESTS_RUN + 1))

load_log="$OUTPUT_DIR/load-test.log"
load_summary="$OUTPUT_DIR/load-summary.json"

if ./test-speed-audit-load.sh \
  --base-url "$BASE_URL" \
  --perf-test-token "$PERF_TEST_TOKEN_VALUE" \
  --concurrency "$CONCURRENCY" \
  --duration "$DURATION" \
  ${LOG_FILE:+--log-file "$LOG_FILE"} \
  --summary-file "$load_summary" \
  --skip-cleanup \
  2>&1 | tee "$load_log"; then
  
  log_success "Load test completed"
  TESTS_PASSED=$((TESTS_PASSED + 1))
else
  log_error "Load test failed (check $load_log)"
  TESTS_FAILED=$((TESTS_FAILED + 1))
fi

echo ""

# Step 3: Log Analysis (if log file provided)
if [[ -n "$LOG_FILE" && -f "$LOG_FILE" ]]; then
  echo ""
  echo "========================================================================"
  echo "  Step 3/3: Log Analysis"
  echo "========================================================================"
  echo ""
  
  TESTS_RUN=$((TESTS_RUN + 1))
  
  audit_report="$OUTPUT_DIR/audit-report.json"
  
  if ./analyze-speed-audit-logs.sh "$LOG_FILE" \
    --format json \
    --output "$audit_report" \
    2>&1 | tee "$OUTPUT_DIR/log-analysis.log"; then
    
    log_success "Log analysis completed"
    TESTS_PASSED=$((TESTS_PASSED + 1))
  else
    log_error "Log analysis failed (check $OUTPUT_DIR/log-analysis.log)"
    TESTS_FAILED=$((TESTS_FAILED + 1))
  fi
else
  echo ""
  log_warn "Step 3/3: Log Analysis SKIPPED (no log file provided)"
  log_info "To enable log analysis, provide --log-file <path>"
fi

echo ""

# Final Summary
echo ""
echo "========================================================================"
echo "  Final Summary"
echo "========================================================================"
echo ""
log_info "Tests Run:    $TESTS_RUN"
log_success "Tests Passed: $TESTS_PASSED"
if [[ "$TESTS_FAILED" -gt 0 ]]; then
  log_error "Tests Failed: $TESTS_FAILED"
else
  log_info "Tests Failed: $TESTS_FAILED"
fi
echo ""
log_info "Output Directory: $OUTPUT_DIR"
echo ""

# List output files
log_info "Generated Files:"
echo ""
ls -lh "$OUTPUT_DIR"/*.json "$OUTPUT_DIR"/*.log 2>/dev/null | awk '{print "  " $NF " (" $5 ")"}'
echo ""

# Quick insights from summaries
if [[ -f "$functional_summary" ]]; then
  log_info "Functional Test Highlights:"
  node -e "
    const summary = JSON.parse(require('fs').readFileSync('$functional_summary', 'utf8'));
    console.log('  Total audit log checks: ' + summary.total);
    console.log('  Passed: ' + summary.passed);
    console.log('  Failed: ' + summary.failed);
  " 2>/dev/null || true
  echo ""
fi

if [[ -f "$load_summary" ]]; then
  log_info "Load Test Highlights:"
  node -e "
    const summary = JSON.parse(require('fs').readFileSync('$load_summary', 'utf8'));
    if (summary.thresholds) {
      const t = summary.thresholds;
      console.log('  Slide edit success rate: ' + (t.slide_edit_success_rate * 100).toFixed(1) + '%');
      console.log('  State update success rate: ' + (t.state_update_success_rate * 100).toFixed(1) + '%');
      console.log('  HTTP p95 latency: ' + (t.http_req_duration_p95_ms || 0).toFixed(0) + 'ms');
    }
    if (summary.audit_log_analysis && summary.audit_log_analysis.timing_metrics) {
      const timing = summary.audit_log_analysis.timing_metrics;
      if (timing.outbox_queue_wait_ms) {
        console.log('  Outbox queue wait (p95): ' + timing.outbox_queue_wait_ms.p95.toFixed(0) + 'ms');
      }
      if (timing.ws_delivery_ms) {
        console.log('  WS delivery (p95): ' + timing.ws_delivery_ms.p95.toFixed(0) + 'ms');
      }
    }
  " 2>/dev/null || true
  echo ""
fi

# Exit with appropriate code
if [[ "$TESTS_FAILED" -eq 0 ]]; then
  log_success "✅ ALL SPEED AUDIT TESTS PASSED"
  echo ""
  log_info "Next steps:"
  log_info "  1. Review detailed reports in: $OUTPUT_DIR"
  log_info "  2. Check timing metrics against thresholds in SPEED_AUDIT_TESTING.md"
  log_info "  3. Run cleanup if needed: curl -X DELETE $BASE_URL/api/internal/perf/sessions/<session-id>"
  exit 0
else
  log_error "❌ SOME SPEED AUDIT TESTS FAILED"
  echo ""
  log_error "Check log files in $OUTPUT_DIR for details"
  exit 1
fi
