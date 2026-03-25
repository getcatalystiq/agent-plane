import { cookies } from "next/headers";
import { query, queryOne } from "@/db";
import { TenantRow, ApiKeyRow } from "@/lib/validation";
import { z } from "zod";
import { CompanyForm } from "./company-form";
import { ApiKeysSection } from "./api-keys-section";
import { ClawSoulsSection } from "./clawsouls-section";
import { DeleteCompanyButton } from "./delete-company-button";

export const dynamic = "force-dynamic";

const TenantWithTokenFlag = TenantRow.extend({ has_subscription_token: z.boolean(), has_clawsouls_token: z.boolean() });

export default async function SettingsPage() {
  const cookieStore = await cookies();
  const tenantId = cookieStore.get("ap-active-tenant")?.value;

  if (!tenantId) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">Select a company from the sidebar to view settings.</p>
      </div>
    );
  }

  const tenant = await queryOne(
    TenantWithTokenFlag,
    `SELECT id, name, slug, settings, monthly_budget_usd, status, current_month_spend,
            timezone, logo_url, subscription_base_url, subscription_token_expires_at,
            spend_period_start, created_at,
            subscription_token_enc IS NOT NULL AS has_subscription_token,
            clawsouls_api_token_enc IS NOT NULL AS has_clawsouls_token
     FROM tenants WHERE id = $1`,
    [tenantId],
  );

  if (!tenant) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <p className="text-muted-foreground">Company not found. Select a different company from the sidebar.</p>
      </div>
    );
  }

  const apiKeys = await query(
    ApiKeyRow.omit({ key_hash: true }),
    `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
     FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
    [tenantId],
  );

  return (
    <div className="space-y-6">
      {/* Tenant Details */}
      <CompanyForm tenant={{
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        status: tenant.status,
        timezone: tenant.timezone,
        monthly_budget_usd: tenant.monthly_budget_usd,
        logo_url: tenant.logo_url,
        has_subscription_token: tenant.has_subscription_token,
        subscription_base_url: tenant.subscription_base_url,
        subscription_token_expires_at: tenant.subscription_token_expires_at,
      }} />

      {/* API Keys */}
      <ApiKeysSection tenantId={tenantId} initialKeys={apiKeys} />

      {/* ClawSouls Registry */}
      <ClawSoulsSection tenantId={tenant.id} hasToken={tenant.has_clawsouls_token} />

      {/* Danger Zone */}
      <div className="rounded-lg border border-destructive/30 p-5">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-destructive">Danger Zone</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Permanently delete this company and all its agents, runs, sessions, and API keys.
            </p>
          </div>
          <DeleteCompanyButton tenantId={tenant.id} tenantName={tenant.name} />
        </div>
      </div>
    </div>
  );
}
