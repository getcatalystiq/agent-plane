-- SoulSpec v0.5 alignment: new spec file columns + tenant ClawSouls token
ALTER TABLE agents ADD COLUMN IF NOT EXISTS style_md TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agents_md TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS heartbeat_md TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS user_template_md TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS examples_good_md TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS examples_bad_md TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS soul_spec_version TEXT DEFAULT '0.5';

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS clawsouls_api_token TEXT DEFAULT NULL;

-- Clean break: clear old-format identity content (no backward compat)
UPDATE agents SET soul_md = NULL, identity_md = NULL, identity = NULL WHERE soul_md IS NOT NULL OR identity_md IS NOT NULL;
