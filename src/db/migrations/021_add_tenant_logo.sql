-- Add logo_url to tenants (base64 data URL or external URL)
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS logo_url TEXT;
