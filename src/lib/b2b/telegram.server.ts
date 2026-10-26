import { tg } from "@/lib/bot/telegram.server";
import type { StaffMember } from "@/lib/bot/permissions";
import { LEAD_COLUMNS, LEAD_ORDER, type B2BRequest } from "./navigation";
import { readB2B, type B2BReadStore } from "./reader";

async function openStore(): Promise<B2BReadStore> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Review-only tables are absent from generated types until migration activation.
  const db = supabaseAdmin as unknown as {
    from: (table: string) => ReturnType<typeof supabaseAdmin.from>;
  };
  return {
    async list(start, end) {
      const { data, error } = await db
        .from("b2b_leads")
        .select(LEAD_COLUMNS)
        .order(LEAD_ORDER[0], { ascending: false })
        .order(LEAD_ORDER[1], { ascending: false })
        .range(start, end);
      if (error) throw new Error("B2B_READ_FAILED");
      return data;
    },
    async lead(id) {
      const { data, error } = await db
        .from("b2b_leads")
        .select(LEAD_COLUMNS)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error("B2B_READ_FAILED");
      return data;
    },
    async counts(id) {
      // HEAD count queries: no originals, draft JSON, Message-ID or address payloads.
      const [messages, drafts] = await Promise.all([
        db.from("b2b_messages").select("id", { count: "exact", head: true }).eq("lead_id", id),
        db
          .from("b2b_drafts")
          .select("id,b2b_messages!inner(lead_id)", { count: "exact", head: true })
          .eq("b2b_messages.lead_id", id)
          .eq("status", "DRAFT"),
      ]);
      if (messages.error || drafts.error || messages.count === null || drafts.count === null)
        throw new Error("B2B_COUNT_FAILED");
      return { messages: messages.count, drafts: drafts.count };
    },
    async audit(actor, request) {
      const { error } = await supabaseAdmin.from("staff_audit_log").insert({
        telegram_id: actor,
        action: request.kind === "lead" ? "b2b_lead_read" : "b2b_leads_read",
        details: request.kind === "lead" ? { lead_id: request.id } : { page: request.page },
      });
      if (error) throw new Error("B2B_AUDIT_FAILED");
    },
  };
}

export async function showB2B(
  member: StaffMember | null,
  chat: { id: number; type?: string },
  from: { id: number },
  request: B2BRequest | null,
) {
  const reply = await readB2B(member, chat, from, request, openStore);
  return tg("sendMessage", { chat_id: chat.id, ...reply });
}
