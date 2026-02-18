-- Plugin marketplaces: global registry of Cowork plugin GitHub repos.
-- Trade-off: JSONB on agents for plugin associations instead of a join table.
-- Acceptable for low cardinality (max 20 plugins/agent). If per-plugin state
-- (pinned versions, enable/disable) is ever needed, refactor to a join table.

CREATE TABLE IF NOT EXISTS plugin_marketplaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  github_repo TEXT NOT NULL UNIQUE,  -- e.g. 'anthropics/knowledge-work-plugins'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TRIGGER plugin_marketplaces_updated_at
  BEFORE UPDATE ON plugin_marketplaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Agent plugins column: [{marketplace_id, plugin_name}, ...]
ALTER TABLE agents ADD COLUMN IF NOT EXISTS plugins JSONB NOT NULL DEFAULT '[]';

-- GIN index for containment queries (marketplace DELETE check)
CREATE INDEX IF NOT EXISTS idx_agents_plugins ON agents USING gin (plugins jsonb_path_ops);
