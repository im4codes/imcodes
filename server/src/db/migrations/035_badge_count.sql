-- Add badge_count to users for iOS app icon badge tracking
ALTER TABLE users ADD COLUMN IF NOT EXISTS badge_count INTEGER NOT NULL DEFAULT 0;
