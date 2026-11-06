import { supabaseAdmin } from "@/integrations/supabase/client.server";
import type { BotRole } from "./transport-config";

/** The legacy staff receipt table remains a replay barrier during migration. */
export async function claimBotUpdate(botId: string, updateId: number, role: BotRole) {
  const { data, error } = await supabaseAdmin.rpc(
    "claim_telegram_bot_update" as never,
    {
      p_bot_id: botId,
      p_update_id: updateId,
      p_legacy_staff: role === "staff",
    } as never,
  );
  if (error || typeof data !== "boolean") return { error: { code: "CLAIM_FAILED" } };
  return { error: data ? null : { code: "23505" } };
}
