import { analyzeEmail, firstReplyDraft, inboundSchema, type InboundEmail } from "./core";

export interface IngestionStore {
  save(
    email: InboundEmail,
    analysis: ReturnType<typeof analyzeEmail>,
    draft: ReturnType<typeof firstReplyDraft>,
  ): Promise<{ leadId: string; duplicate: boolean }>;
}
export async function ingestEmail(input: unknown, store: IngestionStore) {
  const email = inboundSchema.parse(input);
  const analysis = analyzeEmail(email);
  const draft = firstReplyDraft(analysis, email);
  const result = await store.save(email, analysis, draft);
  return { ...result, analysis, draft };
}
/** Explicitly injected, isolated mock only: never used as persistent server state. */
export class MockIngestionStore implements IngestionStore {
  readonly messages = new Map<string, { leadId: string; email: InboundEmail }>();
  readonly events: { leadId: string; kind: string }[] = [];
  async save(email: InboundEmail) {
    const key = `${email.mailbox}\u0000${email.messageId}`;
    const previous = this.messages.get(key);
    if (previous) return { leadId: previous.leadId, duplicate: true };
    const chain = [...email.references, ...(email.inReplyTo ? [email.inReplyTo] : [])];
    const parent = chain
      .map((id) => this.messages.get(`${email.mailbox}\u0000${id}`))
      .find((row) => row);
    const leadId = parent?.leadId ?? `mock-${this.messages.size + 1}`;
    this.messages.set(key, { leadId, email });
    this.events.push({ leadId, kind: "received" });
    return { leadId, duplicate: false };
  }
}
