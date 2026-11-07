import { z } from "zod";

export const technicalModelContext = z
  .object({
    state: z.enum(["unselected", "selected", "stale", "excluded", "withdrawn"]),
    revision: z.number().int().nonnegative(),
    sources_version: z.number().int().nonnegative().optional(),
    usable: z.boolean(),
    choice_id: z.string().uuid().optional(),
    identity: z
      .object({
        manufacturer: z.string().min(1).max(1000),
        model: z.string().min(1).max(1000),
        variant_mode: z.enum(["none", "specified"]),
        variant: z.string().max(1000),
      })
      .nullable()
      .optional(),
  })
  .superRefine((v, ctx) => {
    if (
      v.usable !== (v.state === "selected") ||
      (v.state === "selected" && (!v.choice_id || !v.identity))
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "TECH_MODEL_CONTEXT" });
    }
  });
export const technicalModelBinding = z.object({
  captured: technicalModelContext.nullable(),
  current: technicalModelContext,
  matches: z.boolean(),
});
export type TechnicalModelContext = z.infer<typeof technicalModelContext>;
export function modelContextText(context: TechnicalModelContext | null | undefined) {
  if (!context)
    return "⚠️ В этом старом черновике выбор модели не сохранён. Отмените его и начните проверку заново; прежние сведения останутся в истории.";
  let text =
    context.state === "selected"
      ? "🎯 Характеристики проверяются для выбранной модели:"
      : context.state === "stale" || context.state === "excluded"
        ? "⚠️ Выбор модели требует проверки. Подтвердить характеристики пока нельзя."
        : "📋 Выбранной модели из документов нет. Проверьте точную модель и модификацию вручную по паспорту. Это не подтверждает выбор модели для будущего поиска.";
  if (context.identity) {
    const i = context.identity;
    text +=
      "\nПроизводитель: " +
      i.manufacturer +
      "\nМодель: " +
      i.model +
      "\nМодификация: " +
      (i.variant_mode === "none" ? "Отдельной модификации нет" : i.variant);
  }
  return text;
}
export function modelBindingText(binding: z.infer<typeof technicalModelBinding> | undefined) {
  if (!binding) return modelContextText(null);
  let text = modelContextText(binding.captured);
  if (!binding.matches && binding.captured)
    text +=
      "\n\n⚠️ После начала проверки выбор модели изменился. Черновик сохранён, подтверждение недоступно. Отмените черновик, проверьте модель и начните заново.\n\nСейчас:\n" +
      modelContextText(binding.current);
  return text;
}
