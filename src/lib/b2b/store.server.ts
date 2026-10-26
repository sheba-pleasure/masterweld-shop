import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { IngestionStore } from "./ingestion";

/** Prepared persistence adapter; public route intentionally does not enable it. */
export class DatabaseIngestionStore implements IngestionStore {
  async save(...[email, analysis, draft]: Parameters<IngestionStore["save"]>) {
    const db = supabaseAdmin as unknown as {
      rpc: (
        name: string,
        args: Record<string, unknown>,
      ) => Promise<{ data: unknown; error: { message: string } | null }>;
    };
    const { data, error } = await db.rpc("b2b_ingest", {
      p_email: email,
      p_analysis: analysis,
      p_draft: draft,
    });
    if (error)
      throw new Error(
        error.message.includes("B2B_RATE_LIMIT") ? "B2B_RATE_LIMIT" : "B2B_PERSISTENCE_FAILED",
      );
    if (
      !data ||
      typeof data !== "object" ||
      !("leadId" in data) ||
      typeof data.leadId !== "string" ||
      !("duplicate" in data) ||
      typeof data.duplicate !== "boolean"
    )
      throw new Error("B2B_PERSISTENCE_FAILED");
    return { leadId: data.leadId, duplicate: data.duplicate };
  }
}
