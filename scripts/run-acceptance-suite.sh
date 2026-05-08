#!/usr/bin/env bash
set -euo pipefail

if [ -d openspec/changes/memory-system-post-1-1-integration ]; then
  openspec validate memory-system-post-1-1-integration
elif [ -d openspec/changes/memory-system-1.1-foundations ]; then
  openspec validate memory-system-1.1-foundations
else
  openspec validate daemon-memory-pipeline --type spec
fi

npm run build
npx tsc --noEmit
npx tsc -p server/tsconfig.json --noEmit
(cd web && npx tsc --noEmit)

npm run test:unit
npm run test:server
npm run test:web
npm run test:integration
npx vitest run --project e2e test/e2e/memory-pipeline.e2e.test.ts

scripts/check-scope-filter.sh
scripts/check-replication-length-assumptions.sh
scripts/check-no-internal-caller-leak.sh
npm run bench:memory
