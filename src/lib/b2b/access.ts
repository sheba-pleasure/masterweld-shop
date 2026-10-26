import { can, type StaffMember } from "@/lib/bot/permissions";
import { isPrivateChat } from "@/lib/bot/catalog";
export function canReadB2B(member: StaffMember | null, chat: { id: number; type?: string }) {
  return Boolean(
    member && can(member, "manage_b2b_leads") && isPrivateChat(chat, { id: member.telegram_id }),
  );
}
export function canReadEconomics(member: StaffMember | null, chat: { id: number; type?: string }) {
  return canReadB2B(member, chat) && can(member, "view_costs");
}
