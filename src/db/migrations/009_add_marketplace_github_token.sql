-- GitHub token for owned marketplaces (enables push-to-repo editing).
-- NULL = non-owned (read-only). Encrypted with ENCRYPTION_KEY (AES-256-GCM).

ALTER TABLE plugin_marketplaces
  ADD COLUMN IF NOT EXISTS github_token_enc TEXT;
