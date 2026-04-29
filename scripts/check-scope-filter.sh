#!/usr/bin/env bash
# Cross-tenant scope-filter guard
# (memory-system-1.1-foundations P8 / spec.md:336-339)
#
# Greps for any new SQL predicate that filters by `scope` (with or without a
# table alias such as `p.scope`) outside the canonical helper
# `server/src/util/semantic-memory-view.ts:buildScopedWhereClause`.
#
# Allowlisted entries are the four pre-existing recall-route predicates plus
# the per-target singleton lookup in `server/src/routes/server.ts`. They are
# explicitly documented as legacy in the foundations OpenSpec; new code MUST
# go through `buildScopedWhereClause`.
set -euo pipefail
matches=$(git grep -n -E 'WHERE[[:space:]]+([A-Za-z_][A-Za-z0-9_]*\.)?scope[[:space:]]*(=|IN)' -- server/src src shared web test 2>/dev/null || true)
if [[ -z "$matches" ]]; then
  exit 0
fi
bad=$(printf '%s\n' "$matches" \
  | grep -v 'server/src/util/semantic-memory-view.ts' \
  | grep -v 'semantic-memory-view.test' \
  | grep -v -E 'server/src/routes/server.ts:[0-9]+:.*shared_context_projections WHERE scope = '"'"'personal'"'"' AND user_id = \$1 AND project_id = \$2' \
  | grep -v -E 'server/src/routes/shared-context.ts:[0-9]+:[[:space:]]*WHERE scope = '"'"'personal'"'"' AND user_id = \$2' \
  | grep -v -E 'server/src/routes/shared-context.ts:[0-9]+:[[:space:]]*WHERE p\.scope = '"'"'personal'"'"' AND p\.user_id = \$2' \
  | grep -v -E 'server/src/routes/shared-context.ts:[0-9]+:[[:space:]]*WHERE p\.scope IN \('"'"'project_shared'"'"', '"'"'workspace_shared'"'"', '"'"'org_shared'"'"'\)' \
  || true)
if [[ -n "$bad" ]]; then
  echo "Disallowed direct scope filter(s); use buildScopedWhereClause:" >&2
  printf '%s\n' "$bad" >&2
  exit 1
fi
