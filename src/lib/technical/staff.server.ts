import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
import { technicalDocument, technicalReviewState } from "./schema";

const requestSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("read"), productId: z.string().uuid() }).strict(),
  z
    .object({
      op: z.literal("preview"),
      productId: z.string().uuid(),
      document: technicalDocument,
      reviewState: technicalReviewState,
    })
    .strict(),
  z.object({ op: z.literal("apply"), changeId: z.string().uuid() }).strict(),
  z.object({ op: z.literal("undo"), changeId: z.string().uuid() }).strict(),
]);
export type TechnicalRequest = z.infer<typeof requestSchema>;

/** Only called behind the staff webhook gate. SQL rechecks role/ownership/version at commit. */
export async function technicalOperation(
  member: StaffMember,
  chat: { id: number; type?: string },
  from: { id: number },
  input: TechnicalRequest,
): Promise<unknown> {
  if (!isPrivateChat(chat, from) || from.id !== member.telegram_id || !can(member, "edit_products"))
    throw new Error("TECH_DENIED");
  const parsed = requestSchema.safeParse(input);
  if (!parsed.success) throw new Error("TECH_BAD_INPUT");
  const request = parsed.data;
  if (
    request.op === "preview" &&
    request.reviewState === "verified" &&
    !can(member, "publish_products")
  )
    throw new Error("TECH_REVIEW_DENIED");
  const rpc = supabaseAdmin.rpc.bind(supabaseAdmin) as unknown as (
    name: string,
    args: Record<string, unknown>,
  ) => Promise<{ data: unknown; error: { message?: string } | null }>;
  const { data, error } = await rpc("bot_technical_catalog", {
    p_staff_telegram_id: from.id,
    p_op: request.op,
    ...(request.op === "read" || request.op === "preview"
      ? { p_product_id: request.productId }
      : { p_change_id: request.changeId }),
    ...(request.op === "preview"
      ? { p_document: request.document, p_review_state: request.reviewState }
      : {}),
  });
  if (error || !data || typeof data !== "object" || !("ok" in data) || data.ok !== true)
    throw new Error("TECH_OPERATION_UNCONFIRMED");
  return data;
}
