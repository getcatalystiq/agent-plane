-- Rename clawsouls_api_token to clawsouls_api_token_enc to match code convention
ALTER TABLE tenants RENAME COLUMN clawsouls_api_token TO clawsouls_api_token_enc;
