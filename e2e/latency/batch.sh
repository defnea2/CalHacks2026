#!/bin/sh
# Runs every fixture REPS times (one fresh session each) against the tutor-lat stack, then
# saves the module log. Needs: fake-llm.mjs, the worker (LLM_BASE_URL -> fake), vite on 5190.
# Usage: REPS=2 OUT=/tmp/lat/runs sh e2e/latency/batch.sh
export NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost
HERE=$(cd "$(dirname "$0")" && pwd)
FIX="$HERE/../fixtures"
REPS="${REPS:-2}"
OUT="${OUT:-/tmp/lat/runs}"
export OUT
mkdir -p "$OUT"
i=0
while [ "$i" -lt "$REPS" ]; do
  i=$((i + 1))
  for spec in correct-step:22 wrong-step:24 um-pauses:28 noisy:22 interrupt:34; do
    name=${spec%%:*}
    secs=${spec##*:}
    obs=0
    [ "$name" = "correct-step" ] && obs=1
    OBSERVER=$obs node "$HERE/run.mjs" "$FIX/$name.wav" "$name-$i" "$secs" 2>&1 | grep '^\[lat\]'
  done
done
sh "$HERE/fetch-logs.sh" "$OUT/../server.log"
