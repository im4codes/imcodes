-- The v2 enrollment flow was not yet released to production, so Gate A has no
-- legacy-client compatibility requirement. Retire the plaintext-code table
-- before release instead of preserving a hidden fallback that can mint or
-- redeem raw long-term credentials.
DROP TABLE IF EXISTS enrollment_codes;
