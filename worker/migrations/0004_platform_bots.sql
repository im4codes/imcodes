-- Per-user platform bot credentials.
-- Each user registers their own Telegram/Discord/Feishu bot.
-- Webhook URL: /webhook/:platform/:botId

CREATE TABLE platform_bots (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  platform    TEXT NOT NULL,         -- 'telegram' | 'discord' | 'feishu'
  label       TEXT,                  -- user-friendly name (e.g. "My Telegram Bot")
  config_encrypted TEXT NOT NULL,    -- AES-256-GCM encrypted credentials: base64(iv||ciphertext||authTag)
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX platform_bots_user_idx     ON platform_bots(user_id);
CREATE INDEX platform_bots_platform_idx ON platform_bots(platform);
