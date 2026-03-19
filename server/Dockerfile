# ── Stage 1: Build ────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder

WORKDIR /app

# Install deps for server
COPY server/package.json server/package-lock.json* ./server/
RUN cd server && npm ci --ignore-scripts

# Install deps for web
COPY web/package.json web/package-lock.json* web/.npmrc* ./web/
RUN cd web && npm ci --ignore-scripts

# Copy source
COPY server/ ./server/
COPY web/ ./web/
COPY src/shared/ ./src/shared/
COPY shared/ ./shared/

# Build web (BUILD_TIME arg ensures cache is busted on each CI run)
ARG BUILD_TIME
ENV BUILD_TIME=${BUILD_TIME}
RUN cd web && npm run build

# Build server TypeScript
RUN cd server && npm run build

# ── Stage 2: Runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime

WORKDIR /app

# Install production deps only
COPY server/package.json server/package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled server
COPY --from=builder /app/server/dist ./dist

# Copy server src/db/migrations (needed at runtime for runMigrations)
COPY --from=builder /app/server/src/db/migrations ./dist/db/migrations

# Copy web static files
COPY --from=builder /app/web/dist ./web/dist

# Copy landing page
COPY landing/ ./landing/

EXPOSE 3000

ENV NODE_ENV=production
ENV WEB_DIST_PATH=/app/web/dist
ENV LANDING_DIST_PATH=/app/landing

CMD ["node", "dist/index.js"]
