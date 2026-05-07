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
--
-- IMPLEMENTATION NOTE: PostgreSQL CHECK constraints cannot contain
-- subqueries (`SELECT ... FROM jsonb_each(...)` is a subquery, error
-- code 0A000 "cannot use subquery in check constraint"). The standard
-- workaround is to encapsulate the validation in an IMMUTABLE
-- function — function calls from CHECK are allowed, the function body
-- is not subject to the no-subquery rule.

CREATE OR REPLACE FUNCTION bot_platform_caps_is_valid(caps jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  kv record;
BEGIN
  IF caps IS NULL THEN
    RETURN true;
  END IF;
  IF jsonb_typeof(caps) <> 'object' THEN
    RETURN false;
  END IF;
  FOR kv IN SELECT * FROM jsonb_each(caps) LOOP
    IF jsonb_typeof(kv.value) <> 'number' THEN
      RETURN false;
    END IF;
    IF (kv.value)::numeric <= 0 THEN
      RETURN false;
    END IF;
    IF (kv.value)::numeric % 1 <> 0 THEN
      RETURN false;
    END IF;
  END LOOP;
  RETURN true;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'bot_platform_caps_shape_valid'
  ) THEN
    ALTER TABLE tenants
      ADD CONSTRAINT bot_platform_caps_shape_valid
      CHECK (bot_platform_caps_is_valid(bot_platform_caps));
  END IF;
END $$;

COMMENT ON CONSTRAINT bot_platform_caps_shape_valid ON tenants IS
  'bot_platform_caps must be NULL or a JSONB object whose values are all positive integers. Validated at write time via bot_platform_caps_is_valid().';

COMMENT ON FUNCTION bot_platform_caps_is_valid(jsonb) IS
  'Defense-in-depth validator for tenants.bot_platform_caps. Returns true iff the input is NULL or a JSONB object whose values are all positive integers.';
