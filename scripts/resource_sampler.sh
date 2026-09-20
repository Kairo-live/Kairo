#!/bin/bash
# One-off: sample RSS memory + CPU% for the Kairo dev-build processes every
# N seconds, so memory-leak/resource-usage patterns can be reviewed after a
# real test session instead of guessing from a single snapshot.
OUT="$1"
INTERVAL="${2:-15}"
echo "timestamp,pid,name,rss_mb,cpu_pct" > "$OUT"
while true; do
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  for pat in "target/debug/kairo" "server/server.js"; do
    ps aux | grep "$pat" | grep -v grep | while read -r line; do
      pid=$(echo "$line" | awk '{print $2}')
      cpu=$(echo "$line" | awk '{print $3}')
      rss_kb=$(echo "$line" | awk '{print $6}')
      rss_mb=$(echo "scale=1; $rss_kb/1024" | bc 2>/dev/null || echo "$((rss_kb/1024))")
      echo "$ts,$pid,$pat,$rss_mb,$cpu" >> "$OUT"
    done
  done
  sleep "$INTERVAL"
done
