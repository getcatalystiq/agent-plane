-- Add per-tenant Claude subscription token support
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS subscription_base_url TEXT,
  ADD COLUMN IF NOT EXISTS subscription_token_expires_at TIMESTAMPTZ;
