#!/bin/bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE_SCRIPT="$SCRIPT_DIR/test-prod-clicker-slide-storm.sh"

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
OUTPUT_PREFIX="${OUTPUT_PREFIX:-$SCRIPT_DIR/artifacts/prod-clicker-slide-compare}"

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
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --insecure-skip-tls-verify)
      INSECURE_SKIP_TLS_VERIFY=true
      shift
      ;;
    --output-prefix)
      OUTPUT_PREFIX="$2"
      shift 2
      ;;
    --help)
      cat <<'EOF'
Usage: ./test-prod-clicker-slide-compare.sh [options]

Runs the clicker monitor twice:
  1. no-vote
  2. vote-storm

Options:
  --base-url URL               Backend base URL to target
  --concurrency N              Number of concurrent vote submissions in vote-storm mode
  --slide-changes N            Number of clicker slide changes to issue
  --click-interval-ms MS       Delay between clicker requests
  --click-start-delay-ms MS    Delay after observer connect before load starts
  --observer-timeout-ms MS     Timeout for WS/state visibility checks
  --state-poll-interval-ms MS  Poll cadence for /state observer
  --perf-test-token TOKEN      Cleanup token for /api/internal/perf/sessions/:id
  --skip-cleanup               Leave perf sessions behind for inspection
  --insecure-skip-tls-verify   Ignore TLS certificate errors
  --output-prefix PATH         Prefix for generated summary files
  --help                       Show this help message
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

mkdir -p "$(dirname "$OUTPUT_PREFIX")"

NO_VOTE_SUMMARY="${OUTPUT_PREFIX}-no-vote.json"
VOTE_STORM_SUMMARY="${OUTPUT_PREFIX}-vote-storm.json"
COMPARISON_SUMMARY="${OUTPUT_PREFIX}-comparison.json"

run_mode() {
  local mode="$1"
  local summary_file="$2"

  "$BASE_SCRIPT" \
    --base-url "$BASE_URL" \
    --concurrency "$CONCURRENCY" \
    --slide-changes "$SLIDE_CHANGES" \
    --click-interval-ms "$CLICK_INTERVAL_MS" \
    --click-start-delay-ms "$CLICK_START_DELAY_MS" \
    --observer-timeout-ms "$OBSERVER_TIMEOUT_MS" \
    --state-poll-interval-ms "$STATE_POLL_INTERVAL_MS" \
    --traffic-mode "$mode" \
    --perf-test-token "$PERF_TEST_TOKEN_VALUE" \
    ${SKIP_CLEANUP:+--skip-cleanup} \
    ${INSECURE_SKIP_TLS_VERIFY:+--insecure-skip-tls-verify} \
    --summary-file "$summary_file"
}

if [[ "$SKIP_CLEANUP" == "true" ]]; then
  SKIP_CLEANUP="--skip-cleanup"
else
  SKIP_CLEANUP=""
fi

if [[ "$INSECURE_SKIP_TLS_VERIFY" == "true" ]]; then
  INSECURE_SKIP_TLS_VERIFY="--insecure-skip-tls-verify"
else
  INSECURE_SKIP_TLS_VERIFY=""
fi

run_mode "no-vote" "$NO_VOTE_SUMMARY"
run_mode "vote-storm" "$VOTE_STORM_SUMMARY"

node - "$NO_VOTE_SUMMARY" "$VOTE_STORM_SUMMARY" "$COMPARISON_SUMMARY" <<'EOF'
const fs = require('fs');

const [, , noVotePath, voteStormPath, comparisonPath] = process.argv;
const noVote = JSON.parse(fs.readFileSync(noVotePath, 'utf8'));
const voteStorm = JSON.parse(fs.readFileSync(voteStormPath, 'utf8'));

function metric(summary, key) {
  return summary?.verify?.[key] ?? null;
}

function delta(a, b, field) {
  const left = a?.[field];
  const right = b?.[field];
  if (typeof left !== 'number' || typeof right !== 'number') return null;
  return right - left;
}

const comparison = {
  scenario: 'prod-clicker-slide-compare',
  baseUrl: noVote.baseUrl || voteStorm.baseUrl || null,
  generatedAt: new Date().toISOString(),
  noVoteSummaryPath: noVotePath,
  voteStormSummaryPath: voteStormPath,
  noVote,
  voteStorm,
  comparison: {
    clickAckLatencyDeltaMs: {
      p50: delta(metric(noVote, 'clickAckLatency'), metric(voteStorm, 'clickAckLatency'), 'p50Ms'),
      p95: delta(metric(noVote, 'clickAckLatency'), metric(voteStorm, 'clickAckLatency'), 'p95Ms'),
      max: delta(metric(noVote, 'clickAckLatency'), metric(voteStorm, 'clickAckLatency'), 'maxMs'),
    },
    wsPropagationLatencyDeltaMs: {
      p50: delta(metric(noVote, 'wsPropagationLatency'), metric(voteStorm, 'wsPropagationLatency'), 'p50Ms'),
      p95: delta(metric(noVote, 'wsPropagationLatency'), metric(voteStorm, 'wsPropagationLatency'), 'p95Ms'),
      max: delta(metric(noVote, 'wsPropagationLatency'), metric(voteStorm, 'wsPropagationLatency'), 'maxMs'),
    },
    statePollLatencyDeltaMs: {
      p50: delta(metric(noVote, 'statePollLatency'), metric(voteStorm, 'statePollLatency'), 'p50Ms'),
      p95: delta(metric(noVote, 'statePollLatency'), metric(voteStorm, 'statePollLatency'), 'p95Ms'),
      max: delta(metric(noVote, 'statePollLatency'), metric(voteStorm, 'statePollLatency'), 'maxMs'),
    },
  },
};

fs.writeFileSync(comparisonPath, JSON.stringify(comparison, null, 2) + '\n');
EOF

echo "No-vote summary written to $NO_VOTE_SUMMARY"
echo "Vote-storm summary written to $VOTE_STORM_SUMMARY"
echo "Comparison summary written to $COMPARISON_SUMMARY"
