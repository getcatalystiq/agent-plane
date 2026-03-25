import { NextRequest, NextResponse } from "next/server";
import { execute } from "@/db";
import { authenticateApiKey } from "@/lib/auth";
import { getAgentForTenant } from "@/lib/agents";
import { withErrorHandler } from "@/lib/api";
import { getSoul, ClawSoulsError } from "@/lib/clawsouls";
import { filesToColumns } from "@/lib/soul-manifest";
import { deriveIdentity } from "@/lib/identity";
import { z } from "zod";

export const dynamic = "force-dynamic";

const RegistryImportSchema = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});

const DirectImportSchema = z.object({
  files: z.record(z.string(), z.string()),
});

const ImportBodySchema = z.union([RegistryImportSchema, DirectImportSchema]);

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;
  await getAgentForTenant(agentId, auth.tenantId);

  const body = await request.json();
  const parsed = ImportBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "Provide { owner, name } or { files }" } },
      { status: 400 },
    );
  }

  const warnings: string[] = [];
  let files: Record<string, string>;

  if ("owner" in parsed.data) {
    // Fetch from ClawSouls registry
    try {
      const soul = await getSoul(parsed.data.owner, parsed.data.name);
      files = soul.files;
    } catch (err) {
      if (err instanceof ClawSoulsError) {
        return NextResponse.json(
          { error: { code: "upstream_error", message: err.message } },
          { status: err.status ?? 502 },
        );
      }
      throw err;
    }
  } else {
    files = parsed.data.files;
  }

  if (Object.keys(files).length === 0) {
    return NextResponse.json(
      { error: { code: "validation_error", message: "No files to import" } },
      { status: 400 },
    );
  }

  // Map files to DB columns
  const cols = filesToColumns(files);

  // Derive identity from the new content
  const parseResult = deriveIdentity(
    cols.soul_md,
    cols.identity_md,
    cols.style_md,
    cols.agents_md,
    cols.heartbeat_md,
    cols.user_template_md,
    cols.examples_good_md,
    cols.examples_bad_md,
  );

  for (const w of parseResult.warnings) {
    warnings.push(`${w.file}: ${w.message}`);
  }

  // Build UPDATE query
  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const allCols: Record<string, string | null> = {
    ...cols,
    identity: parseResult.identity ? JSON.stringify(parseResult.identity) : null,
  };

  for (const [col, value] of Object.entries(allCols)) {
    sets.push(`${col} = $${idx}`);
    params.push(value);
    idx++;
  }

  sets.push(`updated_at = NOW()`);
  params.push(agentId, auth.tenantId);

  await execute(
    `UPDATE agents SET ${sets.join(", ")} WHERE id = $${idx} AND tenant_id = $${idx + 1}`,
    params,
  );

  const importedFiles = Object.keys(files);

  return NextResponse.json({ imported_files: importedFiles, warnings });
});
