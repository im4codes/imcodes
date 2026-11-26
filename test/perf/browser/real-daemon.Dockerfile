FROM node:24-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends tmux \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --ignore-scripts --no-audit --no-fund
COPY tsconfig.json ./
COPY config/ ./config/
COPY src/ ./src/
COPY shared/ ./shared/
COPY web/src/i18n/locales/ ./web/src/i18n/locales/
COPY scripts/ ./scripts/
RUN npm run build

COPY test/perf/browser/real-daemon.mjs ./test/perf/browser/real-daemon.mjs
# Test-only `qwen` stand-in (see fake-qwen.mjs): a genuine echo path for send-latency.
COPY test/perf/browser/fake-qwen.mjs /usr/local/bin/qwen
RUN chmod +x /usr/local/bin/qwen
CMD ["node", "/repo/test/perf/browser/real-daemon.mjs"]
