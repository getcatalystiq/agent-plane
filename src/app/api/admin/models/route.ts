import { withErrorHandler, jsonResponse } from "@/lib/api";
import { listCatalogModels } from "@/lib/model-catalog";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async () => {
  const models = await listCatalogModels();
  return jsonResponse({ models });
});
