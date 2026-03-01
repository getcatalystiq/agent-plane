-- Cache the Composio MCP server info per agent so we don't recreate the
-- server on every run. The API key is stored AES-256-GCM encrypted.
-- composio_mcp_server_id and composio_mcp_server_name are safe to expose in
-- API responses. composio_mcp_url and composio_mcp_api_key_enc are internal only.
ALTER TABLE agents
  ADD COLUMN composio_mcp_server_id   TEXT,
  ADD COLUMN composio_mcp_server_name TEXT,
  ADD COLUMN composio_mcp_url         TEXT,
  ADD COLUMN composio_mcp_api_key_enc TEXT;
