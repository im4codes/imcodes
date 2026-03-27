import type { Database } from './db/client.js';

/** Environment config loaded from process.env (no DB, that's injected at runtime). */
export interface EnvConfig {
  // Database connection string
  DATABASE_URL: string;

  // Secrets
  JWT_SIGNING_KEY: string;
  BOT_ENCRYPTION_KEY: string;

  // GitHub OAuth (optional — disables GitHub login if absent)
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;

  // Server URL (used to build webhook URLs)
  SERVER_URL: string;

  // Security
  /** Comma-separated allowed origins for browser WebSocket connections.
   * Required in production. If unset and NODE_ENV=development, all origins are allowed.
   * Example: https://imcodes.example.com */
  ALLOWED_ORIGINS?: string;

  /** Comma-separated trusted proxy CIDRs for X-Forwarded-For IP extraction.
   * Example: 10.0.0.0/8,172.16.0.0/12 */
  TRUSTED_PROXIES?: string;

  /** Header name that carries the real client IP injected by the CDN/proxy.
   * Default: cf-connecting-ip (Cloudflare). Use x-real-ip or similar for other CDNs. */
  REAL_IP_HEADER?: string;

  /** Header name that carries the original client-facing hostname set by an upstream proxy.
   * Default: x-original-host. Cloudflare overwrites X-Forwarded-Host, so a separate
   * header (set by e.g. Caddy) is needed to preserve the real domain. */
  ORIGINAL_HOST_HEADER?: string;

  /** Fixed WebAuthn rpId to use for all passkey operations.
   * Must be a registrable domain suffix of every origin that will use passkeys.
   * Example: set to "im.codes" so both app.im.codes and hk.im.codes share passkeys.
   * If unset, rpId is derived from the request host. */
  WEBAUTHN_RP_ID?: string;

  // Network
  /** Host to bind the HTTP server on. Default: 0.0.0.0 (logs a warning). */
  BIND_HOST?: string;
  /** Port to listen on. Default: 19138 */
  PORT?: string;

  // APNs push notifications (iOS)
  /** APNs auth key (.p8 file content, base64 encoded) */
  APNS_KEY?: string;
  /** APNs key ID (from Apple Developer portal) */
  APNS_KEY_ID?: string;
  /** Apple Team ID */
  APNS_TEAM_ID?: string;
  /** APNs bundle ID (e.g. app.imcodes) */
  APNS_BUNDLE_ID?: string;

  // FCM push notifications (Android)
  FCM_SERVER_KEY?: string;

  // Push relay for self-hosted servers without APNs keys (default: https://app.im.codes)
  PUSH_RELAY_URL?: string;

  // Password auth
  /** Default admin password when auto-creating admin user. Default: 'imcodes' */
  DEFAULT_ADMIN_PASSWORD?: string;

  // Landing page
  /** Host that serves the landing page instead of the app (e.g. im.codes). */
  LANDING_HOST?: string;

  // Runtime
  NODE_ENV?: string;
  ENVIRONMENT?: string;
}

/** Full Env type used in Hono context — includes the injected Database instance. */
export interface Env extends EnvConfig {
  /** Injected at app startup via createDatabase(). */
  DB: Database;
}

/** Parse and validate env from process.env. Exits on missing required vars. */
export function loadEnv(): EnvConfig {
  const required = ['DATABASE_URL', 'JWT_SIGNING_KEY'] as const;
  for (const key of required) {
    if (!process.env[key]) {
      console.error(`[startup] Missing required environment variable: ${key}`);
      process.exit(1);
    }
  }

  return {
    DATABASE_URL: process.env.DATABASE_URL!,
    JWT_SIGNING_KEY: process.env.JWT_SIGNING_KEY!,
    BOT_ENCRYPTION_KEY: process.env.BOT_ENCRYPTION_KEY ?? '',
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET,
    SERVER_URL: process.env.SERVER_URL ?? `http://localhost:${process.env.PORT ?? 19138}`,
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS,
    TRUSTED_PROXIES: process.env.TRUSTED_PROXIES,
    REAL_IP_HEADER: process.env.REAL_IP_HEADER,
    ORIGINAL_HOST_HEADER: process.env.ORIGINAL_HOST_HEADER,
    WEBAUTHN_RP_ID: process.env.WEBAUTHN_RP_ID,
    BIND_HOST: process.env.BIND_HOST,
    PORT: process.env.PORT,
    APNS_KEY: process.env.APNS_KEY,
    APNS_KEY_ID: process.env.APNS_KEY_ID,
    APNS_TEAM_ID: process.env.APNS_TEAM_ID,
    APNS_BUNDLE_ID: process.env.APNS_BUNDLE_ID ?? 'app.imcodes',
    FCM_SERVER_KEY: process.env.FCM_SERVER_KEY,
    PUSH_RELAY_URL: process.env.PUSH_RELAY_URL,
    DEFAULT_ADMIN_PASSWORD: process.env.DEFAULT_ADMIN_PASSWORD,
    LANDING_HOST: process.env.LANDING_HOST,
    NODE_ENV: process.env.NODE_ENV,
    ENVIRONMENT: process.env.ENVIRONMENT,
  };
}
