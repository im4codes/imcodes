FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund
# node-datachannel is a native addon fetched via its own postinstall
# (prebuild-install, falling back to a cmake-js source build); the repo-wide
# --ignore-scripts above skips that, leaving direct-file-transfer-worker.ts's
# `import('node-datachannel')` unable to find a native binding. Rebuild just
# this one package instead of dropping --ignore-scripts repo-wide.
RUN npm rebuild node-datachannel
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY config/ ./config/
COPY src/ ./src/
COPY shared/ ./shared/
COPY web/src/i18n/locales/ ./web/src/i18n/locales/
COPY scripts/ ./scripts/
RUN npm run build

COPY test/perf/browser/identity-daemon.mjs ./test/perf/browser/identity-daemon.mjs
CMD ["node", "/repo/test/perf/browser/identity-daemon.mjs"]
