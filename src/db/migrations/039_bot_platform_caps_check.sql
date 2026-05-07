-- Defense-in-depth CHECK on tenants.bot_platform_caps.
--
-- Round-6 review #G: bot_platform_caps is JSONB, no DB-level shape
-- enforcement. An admin (or a bug) writing `{"discord": "ten"}` or
-- `{"discord": -5}` only fails at READ time when getTenantBotCap's
-- Zod schema parses, breaking bot enablement for that tenant. Add a
-- CHECK constraint so corrupt JSONB cannot land in the column.
--
-- The constraint allows NULL (the default — fall back to platform
-- default), and requires every value in the object to be a positive
-- integer. The keys are unconstrained at the DB level (Zod still
-- validates them as ChatPlatform at read time).

ALTER TABLE tenants
  ADD CONSTRAINT bot_platform_caps_shape_valid CHECK (
    bot_platform_caps IS NULL
    OR (
      jsonb_typeof(bot_platform_caps) = 'object'
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_each(bot_platform_caps) AS kv
        WHERE jsonb_typeof(kv.value) <> 'number'
           OR (kv.value)::text::numeric <= 0
           OR (kv.value)::text::numeric <> trunc((kv.value)::text::numeric)
      )
    )
  );

COMMENT ON CONSTRAINT bot_platform_caps_shape_valid ON tenants IS
  'bot_platform_caps must be NULL or a JSONB object whose values are all positive integers. Invalid shapes are rejected at write time so getTenantBotCap cannot encounter a malformed row.';
