#!/usr/bin/env bash
set -euo pipefail

BASE_URL="https://class-collaboration-production.up.railway.app/api"
FRONTEND_URL="http://localhost:3000"
STUDENT_COUNT="100"
OPTION_COUNT=""
BATCH_SIZE="10"
SUMMARY_FILE=""
SKIP_CLEANUP=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --frontend-url)
      FRONTEND_URL="$2"
      shift 2
      ;;
    --students|--student-count)
      STUDENT_COUNT="$2"
      shift 2
      ;;
    --options|--option-count)
      OPTION_COUNT="$2"
      shift 2
      ;;
    --batch-size)
      BATCH_SIZE="$2"
      shift 2
      ;;
    --summary-file)
      SUMMARY_FILE="$2"
      shift 2
      ;;
    --skip-cleanup)
      SKIP_CLEANUP=true
      shift
      ;;
    --help|-h)
      cat <<'EOF'
Usage: ./test-frontend-poll-storm.sh [options]

Options:
  --base-url URL        Backend API URL (default: prod Railway backend)
  --frontend-url URL    Frontend base URL (default: http://localhost:3000)
  --students N          Number of browser clients (default: 100)
  --options N           Number of poll choices (default: same as students)
  --batch-size N        Number of clients to open per batch (default: 10)
  --summary-file PATH   Write JSON summary to PATH
  --skip-cleanup        Leave the session in place
EOF
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

BASE_URL="${BASE_URL%/}"
FRONTEND_URL="${FRONTEND_URL%/}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$SCRIPT_DIR/../apps/web"

if [[ -z "$OPTION_COUNT" ]]; then
  OPTION_COUNT="$STUDENT_COUNT"
fi

if [[ "$SKIP_CLEANUP" == false && -z "${PERF_TEST_TOKEN:-}" ]]; then
  echo "ERROR: PERF_TEST_TOKEN is required unless --skip-cleanup is set" >&2
  exit 1
fi

if [[ "$FRONTEND_URL" =~ ^https?://(localhost|127\.0\.0\.1)(:[0-9]+)?$ ]]; then
  PLAYWRIGHT_USE_WEB_SERVER="1"
else
  PLAYWRIGHT_USE_WEB_SERVER="0"
fi

export PLAYWRIGHT_API_URL="$BASE_URL"
export PLAYWRIGHT_BASE_URL="$FRONTEND_URL"
export PLAYWRIGHT_USE_WEB_SERVER="$PLAYWRIGHT_USE_WEB_SERVER"
export PLAYWRIGHT_DISABLE_ABLY="0"
export PLAYWRIGHT_REUSE_WEB_SERVER="0"
export PLAYWRIGHT_STUDENT_COUNT="$STUDENT_COUNT"
export PLAYWRIGHT_OPTION_COUNT="$OPTION_COUNT"
export PLAYWRIGHT_BATCH_SIZE="$BATCH_SIZE"

if [[ "$SKIP_CLEANUP" == true ]]; then
  export PLAYWRIGHT_SKIP_CLEANUP="1"
fi

if [[ -n "$SUMMARY_FILE" ]]; then
  if [[ "$SUMMARY_FILE" != /* ]]; then
    SUMMARY_FILE="$(pwd)/$SUMMARY_FILE"
  fi
  mkdir -p "$(dirname "$SUMMARY_FILE")"
  export PLAYWRIGHT_SUMMARY_FILE="$SUMMARY_FILE"
fi

pnpm --dir "$WEB_DIR" exec playwright test e2e/prod-frontend-poll-storm.spec.ts --project=chromium --reporter=line
