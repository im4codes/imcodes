export interface Env {
  // D1 database
  DB: D1Database;

  // Durable Objects
  DAEMON_BRIDGE: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace;

  // Secrets (set via wrangler secret put)
  JWT_SIGNING_KEY: string;
  BOT_ENCRYPTION_KEY: string;  // AES-256 key for encrypting platform_bots.config_encrypted

  // Static assets (web/dist via [assets] in wrangler.toml)
  ASSETS: Fetcher;

  // GitHub OAuth
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;

  // Vars
  ENVIRONMENT: string;
  WORKER_URL: string;   // e.g. https://your-worker.workers.dev (used to build webhook URLs)
}
