#!/bin/sh
# Internet path from this laptop to the external APIs: TCP connect, TLS handshake and
# time-to-first-byte of a tiny request (no key, no body), N times each.
# Usage: N=5 sh e2e/latency/net-probe.sh
N="${N:-5}"
for url in https://api.cartesia.ai/ https://openrouter.ai/api/v1/models/does-not-exist; do
  i=0
  while [ "$i" -lt "$N" ]; do
    i=$((i + 1))
    curl -s -o /dev/null -w "$url dns=%{time_namelookup} connect=%{time_connect} tls=%{time_appconnect} ttfb=%{time_starttransfer} total=%{time_total} code=%{http_code}\n" "$url"
  done
done
