const identityFields = ["sku", "title", "brand", "category_id"] as const;

/** Only compare fields present in both snapshots; absence is not a request to clear a value. */
export function changesTechnicalIdentity(before: unknown, after: unknown): boolean {
  if (!before || !after || typeof before !== "object" || typeof after !== "object") return false;
  if (Array.isArray(before) || Array.isArray(after)) return false;
  return identityFields.some(
    (field) =>
      field in before &&
      field in after &&
      (before as Record<string, unknown>)[field] !== (after as Record<string, unknown>)[field],
  );
}

export const technicalIdentityConsequence =
  "⚠️ Изменение названия, бренда, артикула или раздела снимает прежние подтверждённые характеристики с витрины. Их нужно сверить заново: «Редактировать» → «Проверенные характеристики». Возврат прежних полей не подтверждает характеристики автоматически. Также сверьте описание и фотографии.";
