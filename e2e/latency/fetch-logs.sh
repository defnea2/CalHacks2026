#!/bin/sh
# Saves the module log of the latency database (LAT lines) to $1 (default /tmp/lat/server.log).
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
OUT="${1:-/tmp/lat/server.log}"
"${SPACETIME_BIN:-$HOME/.local/bin/spacetime}" logs "${DB:-tutor-lat}" --server local -n "${LINES:-50000}" > "$OUT" 2>/dev/null
wc -l "$OUT"
