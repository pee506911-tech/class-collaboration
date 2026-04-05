#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K6_SCRIPT="$SCRIPT_DIR/k6/prod-vote-storm.js"

BASE_URL="${BASE_URL:-}"
CONCURRENCY="${CONCURRENCY:-100}"
PERF_TEST_TOKEN_VALUE="${PERF_TEST_TOKEN:-}"
SKIP_CLEANUP="${SKIP_CLEANUP:-false}"
INSECURE_SKIP_TLS_VERIFY="${INSECURE_SKIP_TLS_VERIFY:-false}"
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
    --perf-test-token)
      PERF_TEST_TOKEN_VALUE="$2"
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
Usage: ./test-prod-vote-storm.sh [options]

Options:
  --base-url URL               Backend base URL to target
  --concurrency N              Number of students / poll choices (default: 100)
  --perf-test-token TOKEN      Cleanup token for /api/internal/perf/sessions/:id
  --skip-cleanup               Leave the perf session behind for inspection
  --insecure-skip-tls-verify   Ignore TLS certificate errors
  --summary-file PATH          Write a JSON summary extracted from k6 output
  --help                       Show this help message

Environment variables:
  BASE_URL
  CONCURRENCY
  PERF_TEST_TOKEN
  SKIP_CLEANUP
EOF
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      exit 1
      ;;
  esac
done

if ! command -v k6 >/dev/null 2>&1; then
  echo "k6 is required but not installed" >&2
  exit 1
fi

if [[ -z "$BASE_URL" ]]; then
  echo "BASE_URL is required. Pass --base-url or export BASE_URL." >&2
  exit 1
fi

if [[ "$SKIP_CLEANUP" != "true" && "$SKIP_CLEANUP" != "false" ]]; then
  echo "SKIP_CLEANUP must be true or false" >&2
  exit 1
fi

if [[ "$SKIP_CLEANUP" == "false" && -z "$PERF_TEST_TOKEN_VALUE" ]]; then
  echo "PERF_TEST_TOKEN is required for cleanup. Pass --perf-test-token or export PERF_TEST_TOKEN." >&2
  exit 1
fi

run_k6() {
  k6 run \
    --env BASE_URL="$BASE_URL" \
    --env CONCURRENCY="$CONCURRENCY" \
    --env SKIP_CLEANUP="$SKIP_CLEANUP" \
    --env INSECURE_SKIP_TLS_VERIFY="$INSECURE_SKIP_TLS_VERIFY" \
    --env PERF_TEST_TOKEN="$PERF_TEST_TOKEN_VALUE" \
    "$K6_SCRIPT"
}

if [[ -n "$SUMMARY_FILE" ]]; then
  mkdir -p "$(dirname "$SUMMARY_FILE")"
  log_file="$(mktemp "${TMPDIR:-/tmp}/classcolab-prod-vote-storm.XXXXXX")"

  set +e
  run_k6 2>&1 | tee "$log_file"
  k6_status=${PIPESTATUS[0]}
  set -e

  node - "$log_file" "$SUMMARY_FILE" "$k6_status" "$BASE_URL" "$CONCURRENCY" <<'EOF'
const fs = require('fs');

const [, , logPath, summaryPath, exitCodeRaw, baseUrl, concurrencyRaw] = process.argv;
const exitCode = Number(exitCodeRaw);
const requestedConcurrency = Number(concurrencyRaw);
const log = fs.readFileSync(logPath, 'utf8');
const lines = log.split(/\r?\n/).filter(Boolean);
const parsed = [];

for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.includes('"scenario":"prod-vote-storm"')) continue;
  try {
    parsed.push(JSON.parse(trimmed));
  } catch {
    // Ignore non-JSON lines.
  }
}

const verify = parsed.find((entry) => entry.phase === 'verify') || null;
const cleanup = parsed.find((entry) => entry.phase === 'cleanup') || null;

fs.writeFileSync(
  summaryPath,
  JSON.stringify(
    {
      scenario: 'prod-vote-storm',
      baseUrl,
      requestedConcurrency,
      exitCode,
      verify,
      cleanup,
      generatedAt: new Date().toISOString(),
    },
    null,
    2
  ) + '\n'
);
EOF

  rm -f "$log_file"

  if [[ "$k6_status" -ne 0 ]]; then
    echo "k6 exited with status $k6_status" >&2
    exit "$k6_status"
  fi

  echo "JSON summary written to $SUMMARY_FILE"
  exit 0
fi

run_k6
