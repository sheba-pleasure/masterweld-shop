import { TelegramDeliveryError } from "./telegram.server";

export interface UpdateClaimStore {
  claim(id: number): Promise<{ error: { code?: string } | null }>;
}

/** A failed handler may have committed a mutation. Never release its claim blindly. */
export async function processClaimedUpdate(
  id: number,
  store: UpdateClaimStore,
  handle: () => Promise<unknown>,
): Promise<Response> {
  const { error } = await store.claim(id);
  if (error) {
    if (error.code === "23505") return Response.json({ ok: true, duplicate: true });
    console.error("[telegram] claim failed");
    return Response.json({ ok: false, code: "CLAIM_FAILED" }, { status: 503 });
  }
  try {
    await handle();
    return Response.json({ ok: true });
  } catch (error) {
    console.error("[telegram] processing failed; claim retained");
    // Temporary delivery failures request retry, but a duplicate only acknowledges
    // the retained claim, not successful delivery. Recovery requires manual review.
    const temporary = !(error instanceof TelegramDeliveryError) || error.temporary;
    return Response.json({ ok: false, code: "REVIEW_REQUIRED" }, { status: temporary ? 503 : 200 });
  }
}
