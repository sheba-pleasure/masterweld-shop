import type { StaffMember } from "@/lib/bot/permissions";
import { canReadB2B } from "./access";
import {
  B2B_DENIED,
  B2B_READ_ERROR,
  formatLead,
  formatLeads,
  leadsRange,
  validLeadId,
  type B2BMessage,
  type B2BRequest,
  type LeadCounts,
} from "./navigation";

export interface B2BReadStore {
  list(start: number, end: number): Promise<unknown>;
  lead(id: string): Promise<unknown | null>;
  counts(id: string): Promise<LeadCounts>;
  audit(actor: number, request: B2BRequest): Promise<void>;
}
// Factory is invoked only AFTER the actor/private-chat permission gate.
export async function readB2B(
  member: StaffMember | null,
  chat: { id: number; type?: string },
  from: { id: number },
  request: B2BRequest | null,
  openStore: () => Promise<B2BReadStore>,
): Promise<B2BMessage> {
  if (!canReadB2B(member, chat) || from.id !== member?.telegram_id || chat.id !== from.id)
    return { text: B2B_DENIED };
  const range = request ? leadsRange(request.page) : null;
  if (!request || !range || (request.kind === "lead" && !validLeadId(request.id)))
    return { text: "Формат: /leads <страница 1–1000> или /lead <UUID из списка>." };
  try {
    const store = await openStore();
    let reply: B2BMessage;
    if (request.kind === "list") {
      reply = formatLeads(await store.list(range.start, range.end), request.page);
    } else {
      const lead = await store.lead(request.id);
      reply =
        lead === null
          ? { text: "Заявка не найдена." }
          : formatLead(lead, await store.counts(request.id), request.page);
    }
    // Even empty/not-found reads are audited. Failed reads/audit disclose no data.
    await store.audit(from.id, request);
    return reply;
  } catch {
    return { text: B2B_READ_ERROR };
  }
}
