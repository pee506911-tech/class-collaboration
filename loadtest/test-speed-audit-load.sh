#!/bin/bash

set -euo pipefail

# Speed Audit Load Test Runner
# Runs k6 load test and generates audit log timing reports
#
# Usage: ./test-speed-audit-load.sh [options]
#
# This script:
# 1. Sets up test environment
# 2. Runs k6 load test (speed-audit-load.js)
# 3. Extracts timing metrics from k6 output
# 4. Optionally analyzes backend audit logs
# 5. Generates comprehensive JSON summary

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_SCRIPT="$SCRIPT_DIR/k6/speed-audit-load.js"

BASE_URL="${BASE_URL:-}"
CONCURRENCY="${CONCURRENCY:-50}"
TEST_DURATION="${TEST_DURATION:-2m}"
PERF_TEST_TOKEN_VALUE="${PERF_TEST_TOKEN:-}"
SKIP_CLEANUP="${SKIP_CLEANUP:-false}"
SUMMARY_FILE="${SUMMARY_FILE:-}"
LOG_FILE="${LOG_FILE:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --concurrency)
      CONCURRENCY="$2"
      shift 2
      ;;
    --duration)
      TEST_DURATION="$2"
      shift 2
      ;;
    --perf-test-token)
      PERF_TEST_TOKEN_VALUE="$2"
      shift 2
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --summary-file)
      SUMMARY_FILE="$2"
      shift 2
      ;;
    --log-file)
      LOG_FILE="$2"
      shift 2
      ;;
    --help)
      cat <<'EOF'
Usage: ./test-speed-audit-load.sh [options]

Options:
  --base-url URL        Backend base URL (required)
  --concurrency N       Number of concurrent clients (default: 50)
  --duration DURATION   Test duration (default: 2m)
  --perf-test-token T   Token for cleanup (required unless --skip-cleanup)
  --skip-cleanup        Leave the test session in place
  --summary-file PATH   Write JSON summary to PATH
  --log-file PATH       Backend log file for audit log analysis
  --help                Show this help message

Environment variables:
  BASE_URL
  CONCURRENCY
  TEST_DURATION
  PERF_TEST_TOKEN
  SKIP_CLEANUP

This test validates:
  - All 9 audit log points fire under load
  - Timing metrics are within acceptable ranges
  - No errors under concurrent slide edits, votes, and questions

Example:
  ./test-speed-audit-load.sh \
    --base-url https://your-backend.railway.app \
    --concurrency 100 \
    --duration 5m \
    --perf-test-token $PERF_TEST_TOKEN \
    --summary-file audit-load-summary.json \
    --log-file /var/log/backend.log
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

if ! command -v k6 >/dev/null 2>&1; then
  echo "ERROR: k6 is required but not installed" >&2
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

echo ""
echo "========================================================================"
echo "  Speed Audit Load Test"
echo "========================================================================"
echo ""
log_info "Base URL: $BASE_URL"
log_info "Concurrency: $CONCURRENCY"
log_info "Duration: $TEST_DURATION"
log_info "Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo ""

# Run k6 test
run_k6() {
  k6 run \
    --env BASE_URL="$BASE_URL" \
    --env CONCURRENCY="$CONCURRENCY" \
    --env TEST_DURATION="$TEST_DURATION" \
    --env SKIP_CLEANUP="$SKIP_CLEANUP" \
    --env PERF_TEST_TOKEN="$PERF_TEST_TOKEN_VALUE" \
    --out json=/tmp/k6-speed-audit-output.json \
    "$K6_SCRIPT"
}

if [[ -n "$SUMMARY_FILE" ]]; then
  mkdir -p "$(dirname "$SUMMARY_FILE")"
  log_file="$(mktemp "${TMPDIR:-/tmp}/classcolab-speed-audit.XXXXXX")"

  set +e
  run_k6 2>&1 | tee "$log_file"
  k6_status=${PIPESTATUS[0]}
  set -e

  # Extract k6 metrics and audit log analysis
  node - "$log_file" "$SUMMARY_FILE" "$k6_status" "$BASE_URL" "$CONCURRENCY" "$LOG_FILE" <<'NODESCRIPT'
const fs = require('fs');

const [, , logPath, summaryPath, exitCodeRaw, baseUrl, concurrencyRaw, logFilePath] = process.argv;
const exitCode = Number(exitCodeRaw);
const requestedConcurrency = Number(concurrencyRaw);
const log = fs.readFileSync(logPath, 'utf8');

// Parse k6 JSON output
const k6OutputPath = '/tmp/k6-speed-audit-output.json';
let k6Metrics = {};

if (fs.existsSync(k6OutputPath)) {
  try {
    const k6JsonLines = fs.readFileSync(k6OutputPath, 'utf8').split('\n').filter(Boolean);
    const metrics = {};
    
    for (const line of k6JsonLines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'Point' && entry.data) {
          const metricName = entry.data.metric;
          if (!metrics[metricName]) {
            metrics[metricName] = {
              values: [],
              tags: entry.data.tags || {},
            };
          }
          if (entry.data.values) {
            metrics[metricName].values.push(entry.data.values);
          }
        }
      } catch {
        // Skip invalid JSON lines
      }
    }
    
    // Calculate aggregates
    k6Metrics = {};
    for (const [name, data] of Object.entries(metrics)) {
      const allValues = data.values.flatMap(v => Object.values(v));
      if (allValues.length > 0) {
        const sorted = allValues.sort((a, b) => a - b);
        k6Metrics[name] = {
          count: sorted.length,
          min: sorted[0],
          max: sorted[sorted.length - 1],
          avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
          p95: sorted[Math.floor(sorted.length * 0.95)],
          p99: sorted[Math.floor(sorted.length * 0.99)],
        };
      }
    }
  } catch (err) {
    console.error('Warning: Failed to parse k6 JSON output:', err.message);
  }
}

// Parse audit logs from backend log file
let auditLogAnalysis = {};

if (logFilePath && fs.existsSync(logFilePath)) {
  try {
    const backendLog = fs.readFileSync(logFilePath, 'utf8');
    
    // Count audit log occurrences
    const auditLogPatterns = {
      wal_entry_appended: (backendLog.match(/SPEED_AUDIT: WAL entry appended/g) || []).length,
      wal_flush_started: (backendLog.match(/SPEED_AUDIT: WAL session group flush started/g) || []).length,
      wal_flush_completed: (backendLog.match(/SPEED_AUDIT: WAL session group flush completed/g) || []).length,
      outbox_enqueued: (backendLog.match(/SPEED_AUDIT: Event enqueued to outbox/g) || []).length,
      slide_handler_enqueue: (backendLog.match(/SPEED_AUDIT: SLIDES_UPDATE event enqueued/g) || []).length,
      state_handler_enqueue: (backendLog.match(/SPEED_AUDIT: STATE_UPDATE enqueued/g) || []).length,
      outbox_published: (backendLog.match(/SPEED_AUDIT: Event published to broadcast/g) || []).length,
      batch_completed: (backendLog.match(/SPEED_AUDIT: Batch processing completed/g) || []).length,
      ws_delivery: (backendLog.match(/SPEED_AUDIT: WebSocket message sent/g) || []).length,
    };
    
    // Extract timing metrics
    const extractTiming = (pattern) => {
      const matches = backendLog.match(new RegExp(`${pattern}=([0-9]+)`, 'g')) || [];
      return matches.map(m => Number(m.split('=')[1]));
    };
    
    const queueWaitTimes = extractTiming('queue_wait_ms');
    const flushDurations = extractTiming('flush_duration_ms');
    const deliveryTimes = extractTiming('delivery_ms');
    
    const calcStats = (values) => {
      if (values.length === 0) return null;
      const sorted = values.sort((a, b) => a - b);
      return {
        count: sorted.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
        p50: sorted[Math.floor(sorted.length * 0.5)],
        p95: sorted[Math.floor(sorted.length * 0.95)],
        p99: sorted[Math.floor(sorted.length * 0.99)],
      };
    };
    
    auditLogAnalysis = {
      log_counts: auditLogPatterns,
      timing_metrics: {
        outbox_queue_wait_ms: calcStats(queueWaitTimes),
        wal_flush_duration_ms: calcStats(flushDurations),
        ws_delivery_ms: calcStats(deliveryTimes),
      },
      total_audit_logs: Object.values(auditLogPatterns).reduce((a, b) => a + b, 0),
    };
  } catch (err) {
    console.error('Warning: Failed to analyze backend logs:', err.message);
  }
}

// Extract summary from log output
const extractFromLog = (pattern) => {
  const match = log.match(new RegExp(pattern, 'g'));
  return match ? match.length : 0;
};

const summary = {
  testSuite: 'speed-audit-load',
  baseUrl,
  requestedConcurrency,
  exitCode,
  k6_metrics: k6Metrics,
  audit_log_analysis: auditLogAnalysis,
  thresholds: {
    slide_edit_success_rate: k6Metrics['slide_edit_success']?.avg || 0,
    state_update_success_rate: k6Metrics['state_update_success']?.avg || 0,
    vote_success_rate: k6Metrics['vote_success']?.avg || 0,
    question_success_rate: k6Metrics['question_success']?.avg || 0,
    http_req_duration_p95_ms: k6Metrics['http_req_duration']?.p95 || 0,
  },
  generatedAt: new Date().toISOString(),
};

fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
console.log(`\nJSON summary written to ${summaryPath}`);
NODESCRIPT

  rm -f /tmp/k6-speed-audit-output.json
  rm -f "$log_file"

  if [[ "$k6_status" -ne 0 ]]; then
    echo "k6 exited with status $k6_status" >&2
    exit "$k6_status"
  fi

  echo ""
  log_info "JSON summary written to $SUMMARY_FILE"
  
  # Print summary highlights
  if [[ -f "$SUMMARY_FILE" ]]; then
    echo ""
    echo "========================================================================"
    echo "  Load Test Summary"
    echo "========================================================================"
    echo ""
    
    node -e "
      const summary = JSON.parse(require('fs').readFileSync('$SUMMARY_FILE', 'utf8'));
      
      console.log('k6 Metrics:');
      if (summary.k6_metrics && Object.keys(summary.k6_metrics).length > 0) {
        const metrics = summary.k6_metrics;
        if (metrics.http_req_duration) {
          console.log('  HTTP Request Duration:');
          console.log('    avg: ' + metrics.http_req_duration.avg.toFixed(0) + 'ms');
          console.log('    p95: ' + metrics.http_req_duration.p95.toFixed(0) + 'ms');
          console.log('    p99: ' + metrics.http_req_duration.p99.toFixed(0) + 'ms');
        }
        console.log('');
      }
      
      if (summary.audit_log_analysis && summary.audit_log_analysis.timing_metrics) {
        console.log('Audit Log Timing Metrics:');
        const timing = summary.audit_log_analysis.timing_metrics;
        
        if (timing.outbox_queue_wait_ms) {
          console.log('  Outbox Queue Wait:');
          console.log('    avg: ' + timing.outbox_queue_wait_ms.avg.toFixed(0) + 'ms');
          console.log('    p95: ' + timing.outbox_queue_wait_ms.p95.toFixed(0) + 'ms');
          console.log('    max: ' + timing.outbox_queue_wait_ms.max + 'ms');
        }
        
        if (timing.wal_flush_duration_ms) {
          console.log('  WAL Flush Duration:');
          console.log('    avg: ' + timing.wal_flush_duration_ms.avg.toFixed(0) + 'ms');
        }
        
        if (timing.ws_delivery_ms) {
          console.log('  WebSocket Delivery:');
          console.log('    avg: ' + timing.ws_delivery_ms.avg.toFixed(0) + 'ms');
          console.log('    p95: ' + timing.ws_delivery_ms.p95.toFixed(0) + 'ms');
          console.log('    max: ' + timing.ws_delivery_ms.max + 'ms');
        }
        console.log('');
      }
      
      if (summary.audit_log_analysis && summary.audit_log_analysis.log_counts) {
        console.log('Audit Log Counts:');
        const counts = summary.audit_log_analysis.log_counts;
        console.log('  WAL entries appended: ' + counts.wal_entry_appended);
        console.log('  WAL flushes: ' + counts.wal_flush_completed);
        console.log('  Outbox events enqueued: ' + counts.outbox_enqueued);
        console.log('  Outbox events published: ' + counts.outbox_published);
        console.log('  WS deliveries: ' + counts.ws_delivery);
        console.log('  Total audit logs: ' + summary.audit_log_analysis.total_audit_logs);
        console.log('');
      }
      
      console.log('Success Rates:');
      const t = summary.thresholds;
      console.log('  Slide edits: ' + (t.slide_edit_success_rate * 100).toFixed(1) + '%');
      console.log('  State updates: ' + (t.state_update_success_rate * 100).toFixed(1) + '%');
      console.log('  Votes: ' + (t.vote_success_rate * 100).toFixed(1) + '%');
      console.log('  Questions: ' + (t.question_success_rate * 100).toFixed(1) + '%');
    " 2>/dev/null || true
  fi
  
  exit 0
fi

# No summary file - just run k6
run_k6
