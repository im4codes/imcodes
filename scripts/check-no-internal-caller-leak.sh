#!/usr/bin/env bash
# Internal-only owner-search guard
# (memory-system-1.1-foundations P4 / spec.md:298-311)
#
# `InternalMemoryToolCaller.allowGlobalOwnerSearch` is a daemon-internal debug
# flag that bypasses cross-namespace rejection. It MUST NOT be referenced from
# MCP adapter, web, or any external surface. This script fails CI if the flag
# leaks outside the canonical declaration in
# `src/context/memory-read-tools.ts` (and tests that exercise it).
set -euo pipefail
matches=$(git grep -n -E 'allowGlobalOwnerSearch|_internalChatSearchFtsGlobal|_createInternalMemoryToolCaller|InternalMemoryToolCaller' -- server/src src shared web test 2>/dev/null || true)
if [[ -z "$matches" ]]; then
  exit 0
fi
candidate=$(printf '%s\n' "$matches" \
  | grep -v -E '^src/context/memory-read-tools\.ts:' \
  | grep -v -E '^test/context/memory-read-tools\.test\.ts:' \
  | grep -v -E '^test/context/memory-tool-caller-brand\.test\.ts:' \
  || true)
bad=$(printf '%s\n' "$candidate" | awk '
  /^src\/daemon\/(memory-mcp|send-tool|send-dispatcher|cron-mcp|cron-action-validator)[^:]*:/ { print; next }
  !/^src\/daemon\// { print; next }
' || true)
if [[ -n "$bad" ]]; then
  echo "Disallowed reference(s) to internal owner-search escape hatch:" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi
