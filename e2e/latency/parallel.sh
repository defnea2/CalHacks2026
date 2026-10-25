#!/bin/sh
# K sessions talking at the same moment (one headless Chrome each) to see whether STT/TTS
# procedures of different sessions queue behind each other. Usage: K=4 OUT=/tmp/lat/par sh e2e/latency/parallel.sh
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
HERE=$(cd "$(dirname "$0")" && pwd)
K="${K:-4}"
OUT="${OUT:-/tmp/lat/par}"
FIXTURE="${FIXTURE:-correct-step}"
export OUT
mkdir -p "$OUT"
i=0
while [ "$i" -lt "$K" ]; do
  i=$((i + 1))
  node "$HERE/run.mjs" "$HERE/../fixtures/$FIXTURE.wav" "par$K-$i" 24 2>&1 | grep '^\[lat\]' &
done
wait
sh "$HERE/fetch-logs.sh" "$OUT/../server.log"
