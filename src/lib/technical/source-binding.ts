import { z } from "zod";

export const technicalSourceBinding = z
  .object({
    usable: z.boolean(),
    total: z.number().int().min(0).max(128),
    unavailable: z.number().int().min(0).max(128),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.unavailable > v.total || v.usable !== (v.unavailable === 0))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TECH_SOURCE_STATUS" });
  });

export function sourceBindingText(
  value: z.infer<typeof technicalSourceBinding> | undefined,
): string {
  if (!value) return "";
  if (!value.usable)
    return (
      "\n\n⚠️ Подтверждение исходного документа больше не действует или его данные изменены. Таких значений: " +
      value.unavailable +
      ". Черновик и история сохранены. Уберите неподтверждённые значения, если они не нужны. Для замены источника отмените черновик и начните новый разбор документа. Копирование прежней редакции не возвращает подтверждение."
    );
  return value.total
    ? "\n\n📎 Связь с проверкой исходных документов сохранена для значений: " + value.total + "."
    : "";
}
