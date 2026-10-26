import { z } from "zod";
import { CONTACTS } from "@/lib/contacts";

const header = z
  .string()
  .trim()
  .min(1)
  .max(998)
  .refine((s) => !/[\r\n]/.test(s) && !s.includes("\u0000"));
export const inboundSchema = z
  .object({
    mailbox: z.literal("info@masterweld.ru"),
    messageId: header,
    inReplyTo: header.optional(),
    references: z.array(header).max(40).default([]),
    from: z.string().email().max(254),
    subject: z
      .string()
      .max(500)
      .refine((s) => !/[\r\n]/.test(s) && !s.includes("\u0000")),
    text: z
      .string()
      .min(1)
      .max(100_000)
      .refine((s) => !s.includes("\u0000")),
    attachments: z
      .array(
        z
          .object({
            name: z.string().max(255),
            mime: z.string().max(100),
            size: z.number().int().min(0).max(20_000_000),
          })
          .strict(),
      )
      .max(20)
      .default([]),
  })
  .strict();
export type InboundEmail = z.infer<typeof inboundSchema>;
export type Classification =
  "buyer_request" | "procurement_rfq" | "supplier_offer" | "spam" | "service" | "other";
export const STAGES = [
  "new",
  "qualification",
  "first_contact",
  "clarification",
  "supplier_search",
  "economics",
  "proposal",
  "follow_up",
  "won",
  "lost",
] as const;
export type Evidence = {
  field: string;
  value: string;
  source: "text";
  start: number;
  end: number;
  fragment: string;
};

/** Original email is DATA, never instructions; phase 1 does not invoke an LLM. */
export function analyzeEmail(email: InboundEmail) {
  const content = `${email.subject}\n${email.text}`;
  const procurement =
    /RFQ|запрос\s+(?:котировок|цен|коммерческого)|закуп(?:щик|к[аиу])|тендер|отдел снабжения/i.test(
      content,
    );
  const welding = /свар|резк|электрод|горелк|плазм|металл|weld|cutting|TIG|MIG|MMA/i.test(content);
  const supplier =
    /предлагаем\s+(?:поставки|сотрудничество|продукцию)|мы\s+производител|прайс\s+для\s+дилер/i.test(
      content,
    );
  const service = /delivery status notification|undeliverable|автоответ|не удалось доставить/i.test(
    email.subject,
  );
  const suspicious =
    /ignore (?:all|previous)|system prompt|игнорируй|раскрой.*секрет|отправь.*парол/i.test(content);
  // No auto-spam verdict from bulk delivery, unknown SKU, volume, or uncertain topic.
  const classification: Classification = procurement
    ? "procurement_rfq"
    : supplier
      ? "supplier_offer"
      : service
        ? "service"
        : welding
          ? "buyer_request"
          : "other";
  const evidence: Evidence[] = [];
  const collect = (field: string, re: RegExp) => {
    for (const match of email.text.matchAll(re)) {
      const value = match[1]?.trim();
      if (!value || match.index === undefined) continue;
      const start = match.index + match[0].indexOf(match[1] ?? "");
      evidence.push({
        field,
        value,
        source: "text",
        start,
        end: start + value.length,
        fragment: email.text.slice(start, start + value.length),
      });
    }
  };
  collect("company", /(?:Компания|Организация)\s*:\s*([^\r\n]{1,200})/gi);
  collect("contact", /(?:Контакт|Контактное лицо)\s*:\s*([^\r\n]{1,150})/gi);
  collect("inn", /ИНН\s*[:№]?\s*(\d{10}(?:\d{2})?)(?!\d)/gi);
  collect("item", /(?:Товар|Номенклатура)\s*:\s*([^\r\n]{1,300})/gi);
  collect("model", /Модель\s*:\s*([^\r\n]{1,100})/gi);
  collect("sku", /(?:Артикул|SKU)\s*:\s*([^\r\n]{1,100})/gi);
  collect("quantity", /(?:Количество|Кол-во)\s*:\s*(\d+(?:[.,]\d+)?)/gi);
  collect("unit", /(?:Единица|Ед\.)\s*:\s*([^\r\n]{1,30})/gi);
  collect("deadline", /(?:Срок|Сроки)\s*:\s*([^\r\n]{1,150})/gi);
  collect("delivery", /Доставка\s*:\s*([^\r\n]{1,200})/gi);
  collect("requirements", /(?:Требования|Особые требования)\s*:\s*([^\r\n]{1,300})/gi);
  const fields = [
    "company",
    "contact",
    "inn",
    "item",
    "model",
    "sku",
    "quantity",
    "unit",
    "deadline",
    "delivery",
    "requirements",
  ];
  const large = /ПАО|АО\s|крупн|холдинг|корпорац/i.test(content);
  return {
    engine: "rules_dry_run_v1" as const,
    classification,
    needsReview: true,
    supplyStatus: "requires_verification" as const,
    attachmentReviewRequired: email.attachments.length > 0,
    priority: procurement || large ? ("high_manual" as const) : ("manual" as const),
    urgency: /срочно|до\s+\d|urgent/i.test(content) ? "urgent_manual" : "unknown",
    opportunityValue: "unknown",
    clarity: evidence.length ? "partial" : "unknown",
    domain: email.from.split("@")[1] ?? null,
    evidence,
    unknown: fields.filter((f) => !evidence.some((e) => e.field === f)),
    warnings: [
      ...(suspicious ? ["untrusted_instructions_detected"] : []),
      ...(email.attachments.length ? ["attachments_not_parsed"] : []),
    ],
    rejected: false as const,
  };
}
export type EmailAnalysis = ReturnType<typeof analyzeEmail>;

export function firstReplyDraft(analysis: EmailAnalysis, email?: InboundEmail) {
  // Only confirmed contacts and static language. Never interpolate untrusted email instructions.
  const request =
    analysis.classification === "procurement_rfq"
      ? "запрос котировок"
      : analysis.classification === "supplier_offer"
        ? "предложение о сотрудничестве"
        : "обращение по сварке, резке и смежным товарам";
  return {
    status: "DRAFT" as const,
    requiresHumanApproval: true as const,
    sendAllowed: false as const,
    alternatives: [] as string[],
    prices: [] as number[],
    availabilityPromise: false,
    deliveryPromise: false,
    fulfillmentPromise: false as const,
    supplyStatus: analysis.supplyStatus,
    attachmentReviewRequired: analysis.attachmentReviewRequired,
    // Missing extracted fields are not proof of missing information in the original/TZ.
    // A person checks the original before asking only necessary follow-up questions.
    questions: [] as string[],
    subject: email ? `Re: ${email.subject}` : "Ответ на обращение",
    sourceMessageId: email?.messageId ?? null,
    body: `Здравствуйте!\n\nБлагодарим за ваш ${request}. Подтверждаем получение обращения в интернет-магазине «Мастер Сварщик».\n\nИзучаем ваш запрос и проверяем возможность его исполнения с учётом указанных требований. ${analysis.attachmentReviewRequired ? "Приложенные материалы проверим вручную; повторно предоставлять спецификацию не требуется." : "Сначала внимательно рассмотрим предоставленные сведения."} Если после проверки потребуется уточнение, зададим только необходимые вопросы.\n\nС уважением,\nинтернет-магазин «Мастер Сварщик»\n${CONTACTS.phoneDisplay}\n${CONTACTS.email}`,
  };
}

export function economicsModel() {
  return {
    currency: "RUB",
    purchaseUnit: null,
    quantity: null,
    logistics: null,
    taxScheme: null,
    taxes: null,
    commissions: null,
    risks: null,
    saleTotal: null,
    grossProfit: null,
    marginPercent: null,
    status: "UNKNOWN",
  };
}
export function calculateEconomics(input: {
  purchaseUnit: number;
  quantity: number;
  logistics: number;
  taxes: number;
  commissions: number;
  risks: number;
  saleTotal: number;
  taxScheme: string;
}) {
  const values = [
    input.purchaseUnit,
    input.quantity,
    input.logistics,
    input.taxes,
    input.commissions,
    input.risks,
    input.saleTotal,
  ];
  if (
    !input.taxScheme.trim() ||
    values.some((v) => !Number.isFinite(v) || v < 0) ||
    input.quantity <= 0 ||
    input.saleTotal <= 0
  )
    return { status: "UNKNOWN" as const };
  const costs =
    Math.round(
      (input.purchaseUnit * input.quantity +
        input.logistics +
        input.taxes +
        input.commissions +
        input.risks) *
        100,
    ) / 100;
  const grossProfit = Math.round((input.saleTotal - costs) * 100) / 100;
  return {
    status: "CALCULATED" as const,
    costs,
    grossProfit,
    marginPercent: Math.round((grossProfit / input.saleTotal) * 10000) / 100,
  };
}

/** There is deliberately no SMTP/send implementation in phase 1. */
export function requestSend(): never {
  throw new Error("B2B_AUTO_SEND_DISABLED");
}

export function safeLogMetadata(email: InboundEmail) {
  return { attachmentCount: email.attachments.length, textLength: email.text.length };
}
