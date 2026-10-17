#!/usr/bin/env bash
# Replay clips through the unmodified upstream stream_llama route and the C++
# port; require byte-identical transcripts (every `text=` line + final) AND
# byte-identical per-step decode traces. Results -> reference/results/.
#   scripts/conformance.sh            # default case matrix
source "$(dirname "$0")/common.sh"
out="$SPIKE_DIR/reference/results"; mkdir -p "$out"
cli="$CACHE_DIR/build-host/r2t2-cli"
cases=${CASES:-"zh_upstream_test:Chinese zh_upstream_test:auto en_tts:English en_tts:auto zh_quiet_onset:Chinese"}
pass=0; fail=0
summary="$out/conformance-summary.txt"; : > "$summary"
for c in $cases; do
  clip=${c%%:*}; lang=${c##*:}; wav="$SPIKE_DIR/samples/$clip.wav"; tag="${clip}.${lang}"
  "$SPIKE_DIR/scripts/run-reference.sh" "$wav" "$lang" stream >"$out/$tag.upstream.txt" 2>"$out/$tag.upstream.stderr"
  grep '^\[llama\]' "$out/$tag.upstream.stderr" > "$out/$tag.upstream.trace"; rm -f "$out/$tag.upstream.stderr"
  grep -E '^(text=|finish state.text=|final_result=)' "$out/$tag.upstream.txt" > "$out/$tag.upstream.lines" && mv "$out/$tag.upstream.lines" "$out/$tag.upstream.txt"
  langarg=(); [ "$lang" != auto ] && langarg=(--language "$lang")
  R2T2_TRACE=1 "$cli" --model "$MODEL_GGUF" --mmproj "$MMPROJ_GGUF" --wav "$wav" --mode stream ${langarg[@]+"${langarg[@]}"} \
    --threads 8 --ctx 32768 --quiet --json "$out/$tag.cpp.json" >"$out/$tag.cpp.txt" 2>"$out/$tag.cpp.stderr"
  grep '^\[llama\]' "$out/$tag.cpp.stderr" | sed 's/ prefix=.*//' > "$out/$tag.cpp.trace"; rm -f "$out/$tag.cpp.stderr"
  if diff -q "$out/$tag.upstream.txt" "$out/$tag.cpp.txt" >/dev/null && diff -q "$out/$tag.upstream.trace" "$out/$tag.cpp.trace" >/dev/null; then
    r=IDENTICAL; pass=$((pass+1))
  else
    r=DIFFERENT; fail=$((fail+1))
  fi
  steps=$(wc -l < "$out/$tag.cpp.trace" | tr -d ' ')
  final=$(grep '^final_result=' "$out/$tag.cpp.txt" | sed 's/^final_result=//')
  printf '%-32s %-9s steps=%-3s final=%s\n' "$tag" "$r" "$steps" "$final" | tee -a "$summary"
done
echo "conformance: $pass identical, $fail different" | tee -a "$summary"
[ "$fail" -eq 0 ]
