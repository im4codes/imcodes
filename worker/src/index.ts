import { Hono } from 'hono';
import type { Env } from './types.js';
import { githubAuthRoutes } from './routes/github-auth.js';
import { authRoutes } from './routes/auth.js';
import { bindRoutes } from './routes/bind.js';
import { serverRoutes } from './routes/server.js';
import { webhookRoutes } from './routes/webhook.js';
import { teamRoutes } from './routes/team.js';
import { sessionMgmtRoutes } from './routes/session-mgmt.js';
import { terminalRoutes } from './routes/terminal.js';
import { outboundRoutes } from './routes/outbound.js';
import { cronApiRoutes } from './routes/cron-api.js';
import { projectRoutes } from './routes/projects.js';
import { pushRoutes } from './routes/push.js';
import { botRoutes } from './routes/bot.js';
import { quickDataRoutes } from './routes/quick-data.js';
import { healthCheckCron } from './cron/health-check.js';
import { jobDispatchCron } from './cron/job-dispatch.js';

export { DaemonBridge } from '../durable-objects/DaemonBridge.js';
export { RateLimiter } from '../durable-objects/RateLimiter.js';

const app = new Hono<{ Bindings: Env }>();

// Routes
app.route('/api/auth/github', githubAuthRoutes);
app.route('/api/auth', authRoutes);
app.route('/api/bind', bindRoutes);
app.route('/api/server', serverRoutes);
app.route('/api/server', terminalRoutes);
app.route('/api/server', sessionMgmtRoutes);
app.route('/api/team', teamRoutes);
app.route('/api/cron', cronApiRoutes);
app.route('/api/outbound', outboundRoutes);
app.route('/api/server', projectRoutes);
app.route('/api/push', pushRoutes);
app.route('/api/bot', botRoutes);
app.route('/api/quick-data', quickDataRoutes);
app.route('/webhook', webhookRoutes);

// Health check
app.get('/api/health', (c) => c.json({ service: 'imcodes-worker', status: 'ok' }));

// SPA fallback — serve index.html for all non-API routes
app.get('*', async (c) => {
  const url = new URL(c.req.url);
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/webhook')) {
    return c.json({ error: 'not_found' }, 404);
  }
  // Try exact asset first, fall back to index.html for SPA routing
  const assetRes = await c.env.ASSETS.fetch(c.req.raw).catch(() => null);
  if (assetRes && assetRes.status !== 404) return assetRes;
  return c.env.ASSETS.fetch(new Request(new URL('/index.html', url).toString()));
});

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return app.fetch(req, env, ctx);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        if (event.cron === '*/5 * * * *') await healthCheckCron(env);
        if (event.cron === '* * * * *') await jobDispatchCron(env);
      })(),
    );
  },
};
