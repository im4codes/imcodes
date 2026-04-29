#!/usr/bin/env bash
set -euo pipefail
matches=$(git grep -n -E 'source_event_ids(_json)?' -- server/src src/context src/daemon 2>/dev/null || true)
if [[ -z "$matches" ]]; then exit 0; fi
bad=''
while IFS=: read -r file line rest; do
  start=$(( line > 5 ? line - 5 : 1 ))
  window=$(sed -n "${start},$((line+5))p" "$file")
  if printf '%s\n' "$window" | grep -E 'slice\(0,[[:space:]]*[0-9]+\)|length[[:space:]]*[<>]=?[[:space:]]*[0-9]+' >/dev/null; then
    if ! printf '%s\n' "$window" | grep -q 'source-event-length-allowlist'; then
      bad+="$file:$line:$rest"$'\n'
    fi
  fi
done <<< "$matches"
if [[ -n "$bad" ]]; then
  echo "Hard-coded source_event_ids length assumption(s) found:" >&2
  printf '%s' "$bad" >&2
  exit 1
fi
