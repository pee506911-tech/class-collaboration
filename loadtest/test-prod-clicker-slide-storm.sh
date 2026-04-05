#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NODE_SCRIPT="$SCRIPT_DIR/run-prod-clicker-slide-monitor.js"

BASE_URL="${BASE_URL:-}"
CONCURRENCY="${CONCURRENCY:-100}"
SLIDE_CHANGES="${SLIDE_CHANGES:-3}"
CLICK_INTERVAL_MS="${CLICK_INTERVAL_MS:-250}"
CLICK_START_DELAY_MS="${CLICK_START_DELAY_MS:-100}"
OBSERVER_TIMEOUT_MS="${OBSERVER_TIMEOUT_MS:-10000}"
STATE_POLL_INTERVAL_MS="${STATE_POLL_INTERVAL_MS:-100}"
PERF_TEST_TOKEN_VALUE="${PERF_TEST_TOKEN:-}"
SKIP_CLEANUP="${SKIP_CLEANUP:-false}"
INSECURE_SKIP_TLS_VERIFY="${INSECURE_SKIP_TLS_VERIFY:-false}"
TRAFFIC_MODE="${TRAFFIC_MODE:-vote-storm}"
SUMMARY_FILE=""

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
    --slide-changes)
      SLIDE_CHANGES="$2"
      shift 2
      ;;
    --click-interval-ms)
      CLICK_INTERVAL_MS="$2"
      shift 2
      ;;
    --click-start-delay-ms)
      CLICK_START_DELAY_MS="$2"
      shift 2
      ;;
    --observer-timeout-ms)
      OBSERVER_TIMEOUT_MS="$2"
      shift 2
      ;;
    --state-poll-interval-ms)
      STATE_POLL_INTERVAL_MS="$2"
      shift 2
      ;;
    --perf-test-token)
      PERF_TEST_TOKEN_VALUE="$2"
      shift 2
      ;;
    --traffic-mode)
      TRAFFIC_MODE="$2"
      shift 2
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --insecure-skip-tls-verify)
      INSECURE_SKIP_TLS_VERIFY=true
      shift
      ;;
    --summary-file)
      SUMMARY_FILE="$2"
      shift 2
      ;;
    --help)
      cat <<'EOF'
Usage: ./test-prod-clicker-slide-storm.sh [options]

Options:
  --base-url URL               Backend base URL to target
  --concurrency N              Number of concurrent vote submissions (default: 100)
  --slide-changes N            Number of clicker slide changes to issue (default: 3)
  --click-interval-ms MS       Delay between clicker requests (default: 250)
  --click-start-delay-ms MS    Delay after observer connect before load starts (default: 100)
  --observer-timeout-ms MS     Timeout for WS/state visibility checks (default: 10000)
  --state-poll-interval-ms MS  Poll cadence for /state observer (default: 100)
  --traffic-mode MODE          no-vote or vote-storm (default: vote-storm)
  --perf-test-token TOKEN      Cleanup token for /api/internal/perf/sessions/:id
  --skip-cleanup               Leave the perf session behind for inspection
  --insecure-skip-tls-verify   Ignore TLS certificate errors
  --summary-file PATH          Write a JSON summary extracted from script output
  --help                       Show this help message

Environment variables:
  BASE_URL
  CONCURRENCY
  SLIDE_CHANGES
  CLICK_INTERVAL_MS
  CLICK_START_DELAY_MS
  OBSERVER_TIMEOUT_MS
  STATE_POLL_INTERVAL_MS
  PERF_TEST_TOKEN
  SKIP_CLEANUP
  TRAFFIC_MODE
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
  echo "BASE_URL is required. Pass --base-url or export BASE_URL." >&2
  exit 1
fi

if [[ "$SKIP_CLEANUP" == "false" && -z "$PERF_TEST_TOKEN_VALUE" ]]; then
  echo "PERF_TEST_TOKEN is required for cleanup. Pass --perf-test-token or export PERF_TEST_TOKEN." >&2
  exit 1
fi

run_monitor() {
  node "$NODE_SCRIPT" \
    --base-url "$BASE_URL" \
    --concurrency "$CONCURRENCY" \
    --slide-changes "$SLIDE_CHANGES" \
    --click-interval-ms "$CLICK_INTERVAL_MS" \
    --click-start-delay-ms "$CLICK_START_DELAY_MS" \
    --observer-timeout-ms "$OBSERVER_TIMEOUT_MS" \
    --state-poll-interval-ms "$STATE_POLL_INTERVAL_MS" \
    --traffic-mode "$TRAFFIC_MODE" \
    --perf-test-token "$PERF_TEST_TOKEN_VALUE" \
    --skip-cleanup "$SKIP_CLEANUP" \
    --insecure-skip-tls-verify "$INSECURE_SKIP_TLS_VERIFY"
}

if [[ -n "$SUMMARY_FILE" ]]; then
  mkdir -p "$(dirname "$SUMMARY_FILE")"
  log_file="$(mktemp "${TMPDIR:-/tmp}/classcolab-prod-clicker-slide-storm.XXXXXX")"

  set +e
  run_monitor 2>&1 | tee "$log_file"
  script_status=${PIPESTATUS[0]}
  set -e

  node - "$log_file" "$SUMMARY_FILE" "$script_status" "$BASE_URL" "$CONCURRENCY" "$SLIDE_CHANGES" "$TRAFFIC_MODE" <<'EOF'
const fs = require('fs');

const [, , logPath, summaryPath, exitCodeRaw, baseUrl, concurrencyRaw, slideChangesRaw, trafficMode] = process.argv;
const exitCode = Number(exitCodeRaw);
const requestedConcurrency = Number(concurrencyRaw);
const requestedSlideChanges = Number(slideChangesRaw);
const log = fs.readFileSync(logPath, 'utf8');
const lines = log.split(/\r?\n/).filter(Boolean);
const parsed = [];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"scenario":"prod-clicker-slide-storm"')) continue;
  try {
    parsed.push(JSON.parse(trimmed));
  } catch {
    // Ignore non-JSON lines.
  }
}

const setup = parsed.find((entry) => entry.phase === 'setup') || null;
const verify = parsed.find((entry) => entry.phase === 'verify') || null;
const cleanup = parsed.find((entry) => entry.phase === 'cleanup') || null;
const fatal = parsed.find((entry) => entry.phase === 'fatal') || null;
const clickerAcks = parsed.filter((entry) => entry.phase === 'clicker-ack');
const wsObserved = parsed.filter((entry) => entry.phase === 'ws-observed');
const stateObserved = parsed.filter((entry) => entry.phase === 'state-observed');
const voteSummary = parsed.find((entry) => entry.phase === 'vote-summary') || null;

fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      scenario: 'prod-clicker-slide-storm',
      trafficMode,
      baseUrl,
      requestedConcurrency,
      requestedSlideChanges,
      exitCode,
      setup,
      voteSummary,
      clickerAcks,
      wsObserved,
      stateObserved,
      verify,
      cleanup,
      fatal,
      generatedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);
EOF

  rm -f "$log_file"

  if [[ "$script_status" -ne 0 ]]; then
    echo "monitor script exited with status $script_status" >&2
    exit "$script_status"
  fi

  echo "JSON summary written to $SUMMARY_FILE"
  exit 0
fi

run_monitor
