#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_SCRIPT="$SCRIPT_DIR/k6/prod-concurrency.js"

BASE_URL="http://localhost:8080"
CONCURRENCY=100
QUESTION_CONCURRENCY=30
UPVOTE_CONCURRENCY=40
STATS_POLL_COUNT=4
SKIP_CLEANUP=false
CLEANUP_DELETE_CREATOR_USER=true
INSECURE_SKIP_TLS_VERIFY=false
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
    --question-concurrency)
      QUESTION_CONCURRENCY="$2"
      shift 2
      ;;
    --upvote-concurrency)
      UPVOTE_CONCURRENCY="$2"
      shift 2
      ;;
    --stats-polls)
      STATS_POLL_COUNT="$2"
      shift 2
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --keep-creator-user)
      CLEANUP_DELETE_CREATOR_USER=false
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
Usage: ./test-concurrency-k6.sh [options]

Options:
  --base-url URL               Backend HTTPS origin (default: http://localhost:8080)
  --concurrency N              Student auth/register/vote burst size (default: 100)
  --question-concurrency N      Concurrent question submissions (default: 30)
  --upvote-concurrency N        Concurrent question upvotes (default: 40)
  --stats-polls N              Number of parallel stats reads (default: 4)
  --skip-cleanup               Leave the perf session behind for inspection
  --keep-creator-user          Keep the temporary staff user after cleanup
  --insecure-skip-tls-verify   Ignore TLS certificate errors
  --summary-file PATH          Write a JSON summary for CI parsing
  --help                       Show this help message
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is required but not installed" >&2
  exit 1
fi

: "${ABLY_API_KEY:?ABLY_API_KEY is required to validate Ably token requests}"
if [ "$SKIP_CLEANUP" = false ]; then
  : "${PERF_TEST_TOKEN:?PERF_TEST_TOKEN is required for cleanup}"
fi

if [ -n "$SUMMARY_FILE" ]; then
  summary_dir="$(dirname "$SUMMARY_FILE")"
  mkdir -p "$summary_dir"
  log_file="$(mktemp "${TMPDIR:-/tmp}/classcolab-k6.XXXXXX.log")"

  set +e
  k6 run \
    --env BASE_URL="$BASE_URL" \
    --env CONCURRENCY="$CONCURRENCY" \
    --env QUESTION_CONCURRENCY="$QUESTION_CONCURRENCY" \
    --env UPVOTE_CONCURRENCY="$UPVOTE_CONCURRENCY" \
    --env STATS_POLL_COUNT="$STATS_POLL_COUNT" \
    --env SKIP_CLEANUP="$SKIP_CLEANUP" \
    --env CLEANUP_DELETE_CREATOR_USER="$CLEANUP_DELETE_CREATOR_USER" \
    --env INSECURE_SKIP_TLS_VERIFY="$INSECURE_SKIP_TLS_VERIFY" \
    --env ABLY_API_KEY="$ABLY_API_KEY" \
    --env PERF_TEST_TOKEN="${PERF_TEST_TOKEN:-}" \
    "$K6_SCRIPT" 2>&1 | tee "$log_file"
  k6_status=${PIPESTATUS[0]}
  set -e

  node - "$log_file" "$SUMMARY_FILE" "$k6_status" "$BASE_URL" <<'EOF'
const fs = require('fs');

const [, , logPath, summaryPath, exitCodeRaw, baseUrl] = process.argv;
const exitCode = Number(exitCodeRaw);
const log = fs.readFileSync(logPath, 'utf8');
const lines = log.split(/\r?\n/).filter(Boolean);
const parsed = [];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"scenario":"prod-concurrency"')) continue;
  try {
    parsed.push(JSON.parse(trimmed));
  } catch {
    // Ignore non-JSON noise that happens to match the prefix filter.
  }
}

const run = parsed.find((entry) => entry.phase === 'run') || null;
const cleanup = parsed.find((entry) => entry.phase === 'cleanup') || null;

fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      scenario: 'prod-concurrency',
      baseUrl,
      exitCode,
      run,
      cleanup,
      generatedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);
EOF

  if [ "$k6_status" -ne 0 ]; then
    echo "k6 exited with status $k6_status" >&2
    exit "$k6_status"
  fi

  echo "JSON summary written to $SUMMARY_FILE"
  exit 0
fi

exec k6 run \
  --env BASE_URL="$BASE_URL" \
  --env CONCURRENCY="$CONCURRENCY" \
  --env QUESTION_CONCURRENCY="$QUESTION_CONCURRENCY" \
  --env UPVOTE_CONCURRENCY="$UPVOTE_CONCURRENCY" \
  --env STATS_POLL_COUNT="$STATS_POLL_COUNT" \
  --env SKIP_CLEANUP="$SKIP_CLEANUP" \
  --env CLEANUP_DELETE_CREATOR_USER="$CLEANUP_DELETE_CREATOR_USER" \
  --env INSECURE_SKIP_TLS_VERIFY="$INSECURE_SKIP_TLS_VERIFY" \
  --env ABLY_API_KEY="$ABLY_API_KEY" \
  --env PERF_TEST_TOKEN="${PERF_TEST_TOKEN:-}" \
  "$K6_SCRIPT"
