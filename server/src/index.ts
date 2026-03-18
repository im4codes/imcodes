/**
 * IM.codes Node.js server entry point.
 * Replaces the Cloudflare Workers deployment.
 */

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { Hono } from 'hono';
import { WebSocketServer } from 'ws';
import proxyAddr from 'proxy-addr';
import cron from 'node-cron';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stat, readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';

import { loadEnv, type Env } from './env.js';
import { createDatabase } from './db/client.js';
import { runMigrations } from './db/migrate.js';
import { authRoutes } from './routes/auth.js';
import { githubAuthRoutes } from './routes/github-auth.js';
import { bindRoutes } from './routes/bind.js';
import { serverRoutes } from './routes/server.js';
import { webhookRoutes } from './routes/webhook.js';
import { outboundRoutes } from './routes/outbound.js';
import { botRoutes } from './routes/bot.js';
import { teamRoutes } from './routes/team.js';
import { cronApiRoutes } from './routes/cron-api.js';
import { pushRoutes } from './routes/push.js';
import { quickDataRoutes } from './routes/quick-data.js';
import { sessionMgmtRoutes } from './routes/session-mgmt.js';
import { subSessionRoutes } from './routes/sub-sessions.js';
import { discussionRoutes } from './routes/discussions.js';
import { preferencesRoutes } from './routes/preferences.js';
import { passkeyRoutes } from './routes/passkey-auth.js';
import { healthCheckCron } from './cron/health-check.js';
import { jobDispatchCron } from './cron/job-dispatch.js';
import { WsBridge } from './ws/bridge.js';
import { MemoryRateLimiter } from './ws/rate-limiter.js';
import { rateLimiter } from './security/lockout.js';
import { csrfMiddleware } from './security/csrf.js';
import { cors } from 'hono/cors';
import { verifyJwt } from './security/crypto.js';
import { resolveServerRole } from './security/authorization.js';
import logger from './util/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Docker: /app/dist/index.js → /app/web/dist
// Dev:    server/dist/index.js → web/dist (two levels up from server/dist)
const WEB_DIST = process.env.WEB_DIST_PATH ?? join(__dirname, '..', '..', 'web', 'dist');
const LANDING_DIST = process.env.LANDING_DIST_PATH ?? join(__dirname, '..', '..', 'landing');

// ── Daemon connection protection ──────────────────────────────────────────────
const daemonConnectLimiter = new MemoryRateLimiter();
let unauthenticatedDaemonCount = 0;
const MAX_UNAUTH_CONNECTIONS = 1000;

// ── Hono app ──────────────────────────────────────────────────────────────────

export function buildApp(env: Env) {
  const app = new Hono<{ Bindings: Env }>();

  // Inject env into every request context
  app.use('*', async (c, next) => {
    if (!c.env) (c as unknown as { env: Env }).env = {} as Env;
    Object.assign(c.env, env);
    await next();
  });

  // Extract real client IP.
  // Priority: REAL_IP_HEADER (CDN-injected, default cf-connecting-ip) → XFF via trusted proxies → socket IP.
  // Runs once per request; routes read c.get('clientIp') — never raw headers.
  const realIpHeader = env.REAL_IP_HEADER ?? 'cf-connecting-ip';
  const originalHostHeader = env.ORIGINAL_HOST_HEADER ?? 'x-original-host';
  const trust = proxyAddr.compile(
    env.TRUSTED_PROXIES
      ? env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  );
  app.use('*', async (c, next) => {
    let socketIp = '127.0.0.1';
    try { socketIp = getConnInfo(c).remote.address ?? '127.0.0.1'; } catch { /* test or non-node context */ }
    // REAL_IP_HEADER is injected by the CDN/proxy and cannot be spoofed by clients.
    const cdnIp = c.req.header(realIpHeader);
    let clientIp: string;
    if (cdnIp) {
      clientIp = cdnIp.trim();
    } else {
      const xff = c.req.header('x-forwarded-for');
      const fakeReq = { socket: { remoteAddress: socketIp }, headers: { 'x-forwarded-for': xff } };
      clientIp = proxyAddr(fakeReq as never, trust);
    }
    c.set('clientIp' as never, clientIp);

    // Resolve trusted host: only honour forwarded-host headers when the request
    // arrived through a trusted proxy (clientIp differs from socketIp).
    const fromTrustedProxy = clientIp !== socketIp;
    // ORIGINAL_HOST_HEADER (default: x-original-host) is set by upstream proxies (e.g. Caddy)
    // and preserved by Cloudflare, which overwrites the standard X-Forwarded-Host with its own hostname.
    const fwdHost = c.req.header(originalHostHeader) ?? c.req.header('x-forwarded-host');
    const resolvedHost = (fromTrustedProxy && fwdHost) ? fwdHost : (c.req.header('host') ?? null);
    c.set('resolvedHost' as never, resolvedHost);

    await next();
  });

  // CORS: allow Capacitor native WebView (capacitor://localhost) to access the API.
  // Web same-origin requests never trigger preflight, so this only affects native clients.
  // Applied to both /api/* and /health so the native app can verify server reachability.
  const corsMiddleware = cors({
    origin: (origin) => {
      const nativeOrigins = ['capacitor://localhost', 'https://localhost', 'http://localhost'];
      const configuredOrigins = [
        env.SERVER_URL,
        ...(env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      ];
      const all = [...configuredOrigins, ...nativeOrigins];
      // Non-whitelisted origins get no Access-Control-Allow-Origin header
      return all.includes(origin) ? origin : '';
    },
    allowHeaders: ['Authorization', 'Content-Type', 'X-CSRF-Token'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false,
  });
  app.use('/api/*', corsMiddleware);
  app.use('/health', corsMiddleware);

  // CSRF protection for all API write operations (skips Bearer auth and safe methods)
  app.use('/api/*', csrfMiddleware());

  app.route('/api/auth', authRoutes);
  app.route('/api/auth/github', githubAuthRoutes);
  app.route('/api/bind', bindRoutes);
  app.route('/api/server', serverRoutes);
  app.route('/webhook', webhookRoutes);
  app.route('/api/outbound', outboundRoutes);
  app.route('/api/bot', botRoutes);
  app.route('/api/team', teamRoutes);
  app.route('/api/cron', cronApiRoutes);
  app.route('/api/push', pushRoutes);
  app.route('/api/quick-data', quickDataRoutes);
  app.route('/api/server', sessionMgmtRoutes);
  app.route('/api/server', subSessionRoutes);
  app.route('/api/server', discussionRoutes);
  app.route('/api/preferences', preferencesRoutes);
  app.route('/api/auth/passkey', passkeyRoutes);

  app.get('/health', (c) => c.json({ ok: true, ts: Date.now() }));

  // Apple App Site Association — required for iOS Associated Domains (webcredentials) to work.
  // Allows the Capacitor app (M675E26Q67.app.imcodes) to use passkeys in WKWebView.
  app.get('/.well-known/apple-app-site-association', (c) => {
    return c.json({
      webcredentials: {
        apps: ['M675E26Q67.app.imcodes'],
      },
    });
  });

  // Security headers for HTML responses — added here since Caddy is a transparent proxy, not an edge.
  const SECURITY_HEADERS: Record<string, string> = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline'",   // Vite bundles inline runtime; tighten with hashes in future
      "style-src 'self' 'unsafe-inline'",
      "connect-src 'self' wss: ws: https://api.github.com",
      "img-src 'self' data: https:",
      "font-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  };

  // Landing page — served when request host matches LANDING_HOST env var
  const landingHost = env.LANDING_HOST;
  app.get('*', async (c, next) => {
    if (!landingHost) return next();
    const host = (c.get('resolvedHost' as never) as string | null) ?? c.req.header('host') ?? '';
    const bare = host.replace(/:\d+$/, '');
    if (bare !== landingHost) return next();

    const reqPath = new URL(c.req.url).pathname;
    const filePath = join(LANDING_DIST, reqPath === '/' ? 'index.html' : reqPath);
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        const ext = filePath.split('.').pop() ?? '';
        const mime: Record<string, string> = {
          html: 'text/html', js: 'application/javascript', css: 'text/css',
          png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml',
          ico: 'image/x-icon',
        };
        const content = await readFile(filePath);
        return new Response(content, {
          headers: { 'Content-Type': mime[ext] ?? 'application/octet-stream', ...SECURITY_HEADERS },
        });
      }
    } catch { /* fall through to landing index */ }
    const html = await readFile(join(LANDING_DIST, 'index.html'));
    return new Response(html, { headers: { 'Content-Type': 'text/html', ...SECURITY_HEADERS } });
  });

  // Static file serving + SPA fallback
  app.get('*', async (c) => {
    const reqPath = new URL(c.req.url).pathname;
    if (reqPath.startsWith('/api/') || reqPath.startsWith('/webhook/')) {
      return c.json({ error: 'not_found' }, 404);
    }

    const filePath = join(WEB_DIST, reqPath === '/' ? 'index.html' : reqPath);
    try {
      const s = await stat(filePath);
      if (s.isFile()) {
        const ext = filePath.split('.').pop() ?? '';
        const mime: Record<string, string> = {
          html: 'text/html', js: 'application/javascript', css: 'text/css',
          png: 'image/png', jpg: 'image/jpeg', svg: 'image/svg+xml',
          woff2: 'font/woff2', ico: 'image/x-icon', json: 'application/json',
        };
        const content = await readFile(filePath);
        const headers: Record<string, string> = { 'Content-Type': mime[ext] ?? 'application/octet-stream' };
        if (ext === 'html') Object.assign(headers, SECURITY_HEADERS);
        return new Response(content, { headers });
      }
    } catch { /* fall through */ }

    // SPA fallback
    try {
      const html = await readFile(join(WEB_DIST, 'index.html'));
      return new Response(html, { headers: { 'Content-Type': 'text/html', ...SECURITY_HEADERS } });
    } catch {
      return c.text('Not found', 404);
    }
  });

  return app;
}

// ── WebSocket upgrade handler ─────────────────────────────────────────────────

function setupWebSocketUpgrade(server: import('node:http').Server, env: Env) {
  const wss = new WebSocketServer({ noServer: true });
  // Compile trust function once — same proxy-addr library used by HTTP middleware
  const wsTrust = proxyAddr.compile(
    env.TRUSTED_PROXIES
      ? env.TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean)
      : [],
  );

  server.on('upgrade', async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const match = url.pathname.match(/^\/api\/server\/([^/]+)\/(ws|terminal)$/);
    if (!match) { socket.destroy(); return; }

    const [, serverId, endpoint] = match;

    if (endpoint === 'ws') {
      // Daemon connection — per-IP rate limit + global cap
      const ip = proxyAddr(req as never, wsTrust);
      if (!daemonConnectLimiter.check(`daemon:${ip}`, 5, 10_000)) {
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }
      if (unauthenticatedDaemonCount >= MAX_UNAUTH_CONNECTIONS) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }

      unauthenticatedDaemonCount++;
      wss.handleUpgrade(req, socket, head, (ws) => {
        let counted = true;
        const decrement = () => {
          if (counted) { counted = false; unauthenticatedDaemonCount = Math.max(0, unauthenticatedDaemonCount - 1); }
        };
        WsBridge.get(serverId).handleDaemonConnection(ws, env.DB, env, decrement);
        ws.once('close', decrement); // also decrement if auth never completes
      });

    } else {
      // Browser terminal connection — Origin + ticket + access control
      const origin = req.headers['origin'] ?? '';
      if (!validateOrigin(origin, env)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        socket.destroy();
        return;
      }

      const ticket = url.searchParams.get('ticket');
      if (!ticket) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }

      const payload = verifyJwt(ticket, env.JWT_SIGNING_KEY);
      if (!payload || payload.type !== 'ws-ticket' || payload.sid !== serverId) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }

      const jti = payload.jti as string;
      if (!jti || !rateLimiter.consumeJti(jti, 30_000)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return;
      }

      try {
        const role = await resolveServerRole(env.DB, serverId, payload.sub as string);
        if (role === 'none') { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return; }
      } catch {
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n'); socket.destroy(); return;
      }

      const userId = payload.sub as string;
      wss.handleUpgrade(req, socket, head, (ws) => {
        WsBridge.get(serverId).handleBrowserConnection(ws, userId, env.DB);
      });
    }
  });
}

function validateOrigin(origin: string, env: Env): boolean {
  // Allow Capacitor native WebView origins (matches CORS middleware)
  const nativeOrigins = ['capacitor://localhost', 'https://localhost', 'http://localhost'];
  if (nativeOrigins.includes(origin)) return true;
  if (!env.ALLOWED_ORIGINS) return env.NODE_ENV === 'development';
  return env.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).includes(origin);
}

// ── Cron ──────────────────────────────────────────────────────────────────────

function scheduleCrons(env: Env) {
  cron.schedule('*/5 * * * *', () => {
    healthCheckCron(env).catch((err) => logger.error({ err }, 'Health check cron failed'));
    // Clean up expired auth lockout records older than 1 day
    env.DB.exec("DELETE FROM auth_lockout WHERE locked_until < NOW() - INTERVAL '1 day'")
      .catch((err) => logger.error({ err }, 'Auth lockout cleanup failed'));
  });
  cron.schedule('* * * * *', () => {
    jobDispatchCron(env).catch((err) => logger.error({ err }, 'Job dispatch cron failed'));
  });
  logger.info({}, 'Cron jobs scheduled');
}

// ── Startup ───────────────────────────────────────────────────────────────────

async function main() {
  const envConfig = loadEnv();

  if (!envConfig.JWT_SIGNING_KEY || Buffer.byteLength(envConfig.JWT_SIGNING_KEY, 'utf8') < 32) {
    console.error('FATAL: JWT_SIGNING_KEY must be at least 32 bytes');
    process.exit(1);
  }

  const db = createDatabase(envConfig.DATABASE_URL);
  const env: Env = { ...envConfig, DB: db };

  const bindHost = env.BIND_HOST ?? '0.0.0.0';
  const port = parseInt(env.PORT ?? '3000', 10);

  if (bindHost === '0.0.0.0') {
    logger.warn({}, 'Server is listening on 0.0.0.0 — ensure TLS is terminated by a reverse proxy');
  }
  if (!env.ALLOWED_ORIGINS && env.NODE_ENV !== 'development') {
    logger.error({}, 'ALLOWED_ORIGINS not set — all browser WebSocket connections will be rejected. Set ALLOWED_ORIGINS for production use.');
  } else if (!env.ALLOWED_ORIGINS) {
    logger.warn({}, 'ALLOWED_ORIGINS not set — Origin check disabled (dev mode)');
  }

  await runMigrations(db);

  const app = buildApp(env);

  // serve() returns the http.Server — attach WS upgrade to same server
  const httpServer = serve({ fetch: app.fetch, port, hostname: bindHost }, (info) => {
    logger.info({ port: info.port, host: bindHost }, 'IM.codes server started');
    scheduleCrons(env);
  });

  setupWebSocketUpgrade(httpServer as unknown as import('node:http').Server, env);
}

// Only start the server when run directly (not when imported by tests)
const isMain = import.meta.url === new URL(process.argv[1], 'file://').href ||
  import.meta.url === `file://${process.argv[1]}`;

if (isMain) {
  main().catch((err) => {
    console.error('[startup] Fatal error:', err);
    process.exit(1);
  });
}
