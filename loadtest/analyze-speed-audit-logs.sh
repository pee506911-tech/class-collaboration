#!/usr/bin/env bash
set -euo pipefail

# Speed Audit Log Analyzer
# Parses backend logs to extract timing metrics from SPEED_AUDIT entries
#
# Usage: ./analyze-speed-audit-logs.sh <log-file> [options]
#
# This script:
# 1. Extracts all SPEED_AUDIT log entries
# 2. Calculates timing statistics (avg, p50, p95, p99, max)
# 3. Correlates events by correlation_id
# 4. Generates timeline visualization
# 5. Outputs JSON report

LOG_FILE="${1:-}"
OUTPUT_FORMAT="${OUTPUT_FORMAT:-text}"
OUTPUT_FILE="${OUTPUT_FILE:-}"
SESSION_FILTER="${SESSION_FILTER:-}"
TIME_RANGE_START="${TIME_RANGE_START:-}"
TIME_RANGE_END="${TIME_RANGE_END:-}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --format)
      OUTPUT_FORMAT="$2"
      shift 2
      ;;
    --output)
      OUTPUT_FILE="$2"
      shift 2
      ;;
    --session)
      SESSION_FILTER="$2"
      shift 2
      ;;
    --time-start)
      TIME_RANGE_START="$2"
      shift 2
      ;;
    --time-end)
      TIME_RANGE_END="$2"
      shift 2
      ;;
    --help|-h)
      cat <<'EOF'
Usage: ./analyze-speed-audit-logs.sh <log-file> [options]

Analyze backend audit logs to extract timing metrics and identify bottlenecks.

Arguments:
  log-file              Path to backend log file (required)

Options:
  --format FORMAT       Output format: text (default), json, csv
  --output FILE         Write output to file instead of stdout
  --session ID          Filter to specific session_id
  --time-start TIME     Filter to logs after this time (ISO 8601)
  --time-end TIME       Filter to logs before this time (ISO 8601)
  --help                Show this help message

Environment variables:
  OUTPUT_FORMAT
  OUTPUT_FILE
  SESSION_FILTER
  TIME_RANGE_START
  TIME_RANGE_END

Examples:
  # Analyze all audit logs
  ./analyze-speed-audit-logs.sh backend.log

  # Analyze specific session
  ./analyze-speed-audit-logs.sh backend.log --session abc-123

  # Export JSON report
  ./analyze-speed-audit-logs.sh backend.log --format json --output report.json

  # Analyze time range
  ./analyze-speed-audit-logs.sh backend.log \
    --time-start "2026-04-06T10:00:00Z" \
    --time-end "2026-04-06T11:00:00Z"
EOF
      exit 0
      ;;
    -*)
      # Handle options when log file not provided yet
      if [[ -z "$LOG_FILE" ]]; then
        echo "ERROR: Log file argument is required" >&2
        exit 1
      fi
      ;;
    *)
      if [[ -z "$LOG_FILE" ]]; then
        LOG_FILE="$1"
      fi
      shift
      ;;
  esac
done

if [[ -z "$LOG_FILE" ]]; then
  echo "ERROR: Log file is required" >&2
  exit 1
fi

if [[ ! -f "$LOG_FILE" ]]; then
  echo "ERROR: Log file not found: $LOG_FILE" >&2
  exit 1
fi

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
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

# Filter log file if needed
filter_logs() {
  local input_file="$1"
  local output_file="$2"
  
  local filter_cmd="cat"
  
  # Filter by session
  if [[ -n "$SESSION_FILTER" ]]; then
    filter_cmd="$filter_cmd | grep 'session_id=$SESSION_FILTER'"
  fi
  
  # Filter by time range
  if [[ -n "$TIME_RANGE_START" || -n "$TIME_RANGE_END" ]]; then
    # This is a simplified filter - assumes ISO timestamps in logs
    filter_cmd="$filter_cmd | awk '"
    if [[ -n "$TIME_RANGE_START" ]]; then
      filter_cmd="$filter_cmd && \$0 >= \"$TIME_RANGE_START\""
    fi
    if [[ -n "$TIME_RANGE_END" ]]; then
      filter_cmd="$filter_cmd && \$0 <= \"$TIME_RANGE_END\""
    fi
    filter_cmd="$filter_cmd {print}'"
  fi
  
  eval "$filter_cmd" "$input_file" > "$output_file"
}

# Extract timing values
extract_timing_values() {
  local log_file="$1"
  local pattern="$2"
  
  grep -o "${pattern}=[0-9]*" "$log_file" 2>/dev/null | \
    sed "s/${pattern}=//" | \
    sort -n || echo ""
}

# Calculate statistics
calc_stats() {
  local values="$1"
  
  if [[ -z "$values" ]]; then
    echo "null"
    return
  fi
  
  echo "$values" | awk '
  BEGIN {
    count = 0
    sum = 0
    min = 999999999
    max = 0
  }
  {
    values[count] = $1
    sum += $1
    if ($1 < min) min = $1
    if ($1 > max) max = $1
    count++
  }
  END {
    if (count == 0) {
      print "null"
      exit
    }
    
    avg = sum / count
    p50_idx = int(count * 0.5)
    p95_idx = int(count * 0.95)
    p99_idx = int(count * 0.99)
    
    if (p50_idx >= count) p50_idx = count - 1
    if (p95_idx >= count) p95_idx = count - 1
    if (p99_idx >= count) p99_idx = count - 1
    
    printf "{\"count\":%d,\"min\":%.0f,\"max\":%.0f,\"avg\":%.2f,\"p50\":%.0f,\"p95\":%.0f,\"p99\":%.0f}\n", \
      count, min, max, avg, values[p50_idx], values[p95_idx], values[p99_idx]
  }'
}

# Main analysis
main() {
  local filtered_log
  filtered_log=$(mktemp)
  
  filter_logs "$LOG_FILE" "$filtered_log"
  
  local total_lines
  total_lines=$(wc -l < "$filtered_log")
  
  log_info "Analyzing audit logs from: $LOG_FILE"
  log_info "Total log lines: $total_lines"
  
  if [[ -n "$SESSION_FILTER" ]]; then
    log_info "Filtered to session: $SESSION_FILTER"
  fi
  
  echo ""
  
  # Count audit log occurrences
  log_info "Audit Log Occurrences:"
  echo ""
  
  local wal_append
  wal_append=$(grep -c "SPEED_AUDIT: WAL entry appended" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  WAL entries appended:          $wal_append"
  
  local wal_flush_start
  wal_flush_start=$(grep -c "SPEED_AUDIT: WAL session group flush started" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  WAL flushes started:           $wal_flush_start"
  
  local wal_flush_end
  wal_flush_end=$(grep -c "SPEED_AUDIT: WAL session group flush completed" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  WAL flushes completed:         $wal_flush_end"
  
  local outbox_enqueue
  outbox_enqueue=$(grep -c "SPEED_AUDIT: Event enqueued to outbox" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  Outbox events enqueued:        $outbox_enqueue"
  
  local slide_enqueue
  slide_enqueue=$(grep -c "SPEED_AUDIT: SLIDES_UPDATE event enqueued" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  Slide handler enqueues:        $slide_enqueue"
  
  local state_enqueue
  state_enqueue=$(grep -c "SPEED_AUDIT: STATE_UPDATE enqueued" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  State handler enqueues:        $state_enqueue"
  
  local outbox_publish
  outbox_publish=$(grep -c "SPEED_AUDIT: Event published to broadcast" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  Outbox events published:       $outbox_publish"
  
  local batch_complete
  batch_complete=$(grep -c "SPEED_AUDIT: Batch processing completed" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  Batch processing completed:    $batch_complete"
  
  local ws_delivery
  ws_delivery=$(grep -c "SPEED_AUDIT: WebSocket message sent" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  WebSocket deliveries:          $ws_delivery"
  
  local total_audit_logs
  total_audit_logs=$((wal_append + wal_flush_start + wal_flush_end + outbox_enqueue + \
                      slide_enqueue + state_enqueue + outbox_publish + batch_complete + ws_delivery))
  
  echo ""
  log_info "Total SPEED_AUDIT logs:          $total_audit_logs"
  echo ""
  
  # Extract timing metrics
  log_info "Timing Metrics (milliseconds):"
  echo ""
  
  # Outbox queue wait time
  local queue_wait_values
  queue_wait_values=$(extract_timing_values "$filtered_log" "queue_wait_ms")
  local queue_wait_stats
  queue_wait_stats=$(calc_stats "$queue_wait_values")
  
  if [[ "$queue_wait_stats" != "null" ]]; then
    log_info "  Outbox Queue Wait Time:"
    echo "$queue_wait_stats" | node -e "
      const stats = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      console.log('    count: ' + stats.count);
      console.log('    min:   ' + stats.min + 'ms');
      console.log('    avg:   ' + stats.avg.toFixed(1) + 'ms');
      console.log('    p50:   ' + stats.p50 + 'ms');
      console.log('    p95:   ' + stats.p95 + 'ms');
      console.log('    p99:   ' + stats.p99 + 'ms');
      console.log('    max:   ' + stats.max + 'ms');
    "
    echo ""
  else
    log_warn "  Outbox Queue Wait Time: No data"
    echo ""
  fi
  
  # WAL flush duration
  local flush_duration_values
  flush_duration_values=$(extract_timing_values "$filtered_log" "flush_duration_ms")
  local flush_duration_stats
  flush_duration_stats=$(calc_stats "$flush_duration_values")
  
  if [[ "$flush_duration_stats" != "null" ]]; then
    log_info "  WAL Flush Duration:"
    echo "$flush_duration_stats" | node -e "
      const stats = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      console.log('    count: ' + stats.count);
      console.log('    min:   ' + stats.min + 'ms');
      console.log('    avg:   ' + stats.avg.toFixed(1) + 'ms');
      console.log('    p50:   ' + stats.p50 + 'ms');
      console.log('    p95:   ' + stats.p95 + 'ms');
      console.log('    p99:   ' + stats.p99 + 'ms');
      console.log('    max:   ' + stats.max + 'ms');
    "
    echo ""
  else
    log_warn "  WAL Flush Duration: No data"
    echo ""
  fi
  
  # WebSocket delivery time
  local delivery_values
  delivery_values=$(extract_timing_values "$filtered_log" "delivery_ms")
  local delivery_stats
  delivery_stats=$(calc_stats "$delivery_values")
  
  if [[ "$delivery_stats" != "null" ]]; then
    log_info "  WebSocket Delivery Time:"
    echo "$delivery_stats" | node -e "
      const stats = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      console.log('    count: ' + stats.count);
      console.log('    min:   ' + stats.min + 'ms');
      console.log('    avg:   ' + stats.avg.toFixed(1) + 'ms');
      console.log('    p50:   ' + stats.p50 + 'ms');
      console.log('    p95:   ' + stats.p95 + 'ms');
      console.log('    p99:   ' + stats.p99 + 'ms');
      console.log('    max:   ' + stats.max + 'ms');
    "
    echo ""
  else
    log_warn "  WebSocket Delivery Time: No data"
    echo ""
  fi
  
  # Batch processing time
  local batch_duration_values
  batch_duration_values=$(extract_timing_values "$filtered_log" "batch_duration_ms")
  local batch_duration_stats
  batch_duration_stats=$(calc_stats "$batch_duration_values")
  
  if [[ "$batch_duration_stats" != "null" ]]; then
    log_info "  Batch Processing Duration:"
    echo "$batch_duration_stats" | node -e "
      const stats = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      console.log('    count: ' + stats.count);
      console.log('    min:   ' + stats.min + 'ms');
      console.log('    avg:   ' + stats.avg.toFixed(1) + 'ms');
      console.log('    p50:   ' + stats.p50 + 'ms');
      console.log('    p95:   ' + stats.p95 + 'ms');
      console.log('    p99:   ' + stats.p99 + 'ms');
      console.log('    max:   ' + stats.max + 'ms');
    "
    echo ""
  else
    log_warn "  Batch Processing Duration: No data"
    echo ""
  fi
  
  # Event type breakdown
  log_info "Event Type Breakdown:"
  echo ""
  
  local slide_updates
  slide_updates=$(grep -c "event_type=SLIDES_UPDATE" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  SLIDES_UPDATE:                 $slide_updates"
  
  local state_updates
  state_updates=$(grep -c "event_type=STATE_UPDATE" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  STATE_UPDATE:                  $state_updates"
  
  local vote_updates
  vote_updates=$(grep -c "event_type=VOTE_UPDATE" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  VOTE_UPDATE:                   $vote_updates"
  
  local qa_updates
  qa_updates=$(grep -c "event_type=QA_UPDATE" "$filtered_log" 2>/dev/null || echo "0")
  log_info "  QA_UPDATE:                     $qa_updates"
  
  echo ""
  
  # Identify bottlenecks
  log_info "Bottleneck Analysis:"
  echo ""
  
  if [[ "$queue_wait_stats" != "null" ]]; then
    local p95_queue_wait
    p95_queue_wait=$(echo "$queue_wait_stats" | node -e "
      const stats = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      console.log(stats.p95);
    ")
    
    if (( $(echo "$p95_queue_wait > 200" | bc -l 2>/dev/null || echo "0") )); then
      log_warn "  ⚠️  HIGH OUTBOX QUEUE LATENCY (p95: ${p95_queue_wait}ms)"
      log_info "     → Consider reducing POLL_INTERVAL_MS (currently 100ms)"
      log_info "     → Ensure notify_one() is called after every enqueue"
    else
      log_success "  ✓ Outbox queue latency is good (p95: ${p95_queue_wait}ms)"
    fi
  fi
  
  if [[ "$flush_duration_stats" != "null" ]]; then
    local avg_flush
    avg_flush=$(echo "$flush_duration_stats" | node -e "
      const stats = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      console.log(stats.avg.toFixed(0));
    ")
    
    if (( $(echo "$avg_flush > 100" | bc -l 2>/dev/null || echo "0") )); then
      log_warn "  ⚠️  SLOW WAL FLUSHES (avg: ${avg_flush}ms)"
      log_info "     → Check database indexes"
      log_info "     → Consider reducing FLUSH_INTERVAL_MS (currently 200ms)"
      log_info "     → Review MySQL lock contention"
    else
      log_success "  ✓ WAL flush duration is good (avg: ${avg_flush}ms)"
    fi
  fi
  
  if [[ "$delivery_stats" != "null" ]]; then
    local p95_delivery
    p95_delivery=$(echo "$delivery_stats" | node -e "
      const stats = JSON.parse(require('fs').readFileSync('/dev/stdin', 'utf8'));
      console.log(stats.p95);
    ")
    
    if (( $(echo "$p95_delivery > 20" | bc -l 2>/dev/null || echo "0") )); then
      log_warn "  ⚠️  SLOW WEBSOCKET DELIVERY (p95: ${p95_delivery}ms)"
      log_info "     → Check WebSocket connection count"
      log_info "     → Review tokio runtime saturation"
      log_info "     → Consider send_all() optimization"
    else
      log_success "  ✓ WebSocket delivery is fast (p95: ${p95_delivery}ms)"
    fi
  fi
  
  echo ""
  
  # Generate JSON output if requested
  if [[ "$OUTPUT_FORMAT" == "json" ]]; then
    local json_output
    json_output=$(node -e "
      const summary = {
        analysisType: 'speed-audit-logs',
        sourceFile: '$LOG_FILE',
        analyzedAt: new Date().toISOString(),
        filters: {
          session: '$SESSION_FILTER' || null,
          timeStart: '$TIME_RANGE_START' || null,
          timeEnd: '$TIME_RANGE_END' || null,
        },
        counts: {
          wal_entry_appended: $wal_append,
          wal_flush_started: $wal_flush_start,
          wal_flush_completed: $wal_flush_end,
          outbox_enqueued: $outbox_enqueue,
          slide_handler_enqueue: $slide_enqueue,
          state_handler_enqueue: $state_enqueue,
          outbox_published: $outbox_publish,
          batch_completed: $batch_complete,
          ws_delivery: $ws_delivery,
          total: $total_audit_logs,
        },
        eventTypes: {
          SLIDES_UPDATE: $slide_updates,
          STATE_UPDATE: $state_updates,
          VOTE_UPDATE: $vote_updates,
          QA_UPDATE: $qa_updates,
        },
        timing: {
          outbox_queue_wait_ms: $queue_wait_stats,
          wal_flush_duration_ms: $flush_duration_stats,
          ws_delivery_ms: $delivery_stats,
          batch_duration_ms: $batch_duration_stats,
        },
        totalLogLines: $total_lines,
      };
      
      console.log(JSON.stringify(summary, null, 2));
    ")
    
    if [[ -n "$OUTPUT_FILE" ]]; then
      echo "$json_output" > "$OUTPUT_FILE"
      log_info "JSON report written to: $OUTPUT_FILE"
    else
      echo ""
      echo "========================================================================"
      echo "  JSON Report"
      echo "========================================================================"
      echo ""
      echo "$json_output"
    fi
  fi
  
  # Cleanup
  rm -f "$filtered_log"
}

# Run main analysis
main
