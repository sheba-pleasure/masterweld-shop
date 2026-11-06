import { z } from "zod";

export const technicalProcess = z.enum(["general", "mma", "mig", "tig", "cut", "fcaw"]);
export const technicalReviewState = z.enum(["pending_review", "verified", "conflict"]);
export const technicalKind = z.enum([
  "number",
  "integer",
  "boolean",
  "text",
  "enum",
  "number_list",
  "enum_list",
]);
const code = z.string().regex(/^[a-z][a-z0-9_]{0,79}$/);
const scalar = z.union([
  z.number().finite(),
  z.boolean(),
  z.string().min(1).max(500),
  z.array(z.number().finite()).min(1).max(32),
  z.array(z.string().min(1).max(500)).min(1).max(32),
]);
export const technicalContext = z
  .object({
    current_a: z.number().nonnegative().optional(),
    temperature_c: z.number().min(-100).max(1000000).optional(),
    pressure_bar: z.number().positive().optional(),
    gas: z.string().min(1).max(120).optional(),
    cooling: z.enum(["air", "liquid"]).optional(),
    duty_pct: z.number().min(0).max(100).optional(),
    material: z.string().min(1).max(120).optional(),
    diameter_mm: z.number().positive().optional(),
  })
  .strict();
export const technicalSource = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{0,39}$/),
    kind: z.enum(["manufacturer", "manual", "test_report", "supplier", "research", "synthetic"]),
    publisher: z.string().min(1).max(1000),
    model: z.string().min(1).max(1000),
    title: z.string().min(1).max(1000),
    url: z
      .string()
      .max(1000)
      .refine((v) => v === "" || /^https:\/\/[a-zA-Z0-9.-]+\/[^?#@\s]*$/.test(v)),
    locator: z.string().min(1).max(1000),
    checked_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    sha256: z.string().regex(/^(?:[0-9a-f]{64})?$/),
  })
  .strict()
  .refine((s) => s.url !== "" || s.sha256 !== "");
export const technicalFact = z
  .object({
    attribute_code: code,
    process: technicalProcess,
    state: z.enum(["known", "unknown", "not_applicable"]),
    value: scalar.nullable(),
    unit_code: code,
    context: technicalContext,
    source_key: z.string().nullable(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.state === "known"
        ? v.value === null || !v.source_key
        : v.value !== null || v.source_key !== null || Object.keys(v.context).length !== 0
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TECH_VALUE_STATE" });
    }
  });
export const technicalDocument = z
  .object({
    family_code: code,
    sources: z.array(technicalSource).max(32),
    values: z.array(technicalFact).max(128),
  })
  .strict();
export type TechnicalDocument = z.infer<typeof technicalDocument>;
export type TechnicalReviewState = z.infer<typeof technicalReviewState>;
export const publicTechnicalCard = z
  .object({
    product_id: z.string().uuid(),
    revision_id: z.string().uuid(),
    family: z.object({ code, label: z.string() }).strict(),
    verified_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    values: z
      .array(
        z
          .object({
            code,
            label: z.string(),
            kind: technicalKind,
            process: technicalProcess,
            state: z.enum(["known", "unknown", "not_applicable"]),
            value: scalar.nullable(),
            unit: z.object({ code, label: z.string() }).strict(),
            context: technicalContext,
            source_key: z.string().nullable(),
          })
          .strict(),
      )
      .max(128),
    sources: z.array(technicalSource).max(32),
  })
  .strict();
export type PublicTechnicalCard = z.infer<typeof publicTechnicalCard>;
