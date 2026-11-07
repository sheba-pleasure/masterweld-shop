import { expect, it } from "vitest";
import { technicalModelContext, modelContextText, modelBindingText } from "./model-binding";
const selected = {
  state: "selected" as const,
  revision: 3,
  usable: true,
  choice_id: "10000000-0000-4000-8000-000000000001",
  identity: {
    manufacturer: "Завод",
    model: "aB-220",
    variant_mode: "specified" as const,
    variant: "220V",
  },
};
it("shows the exact model and variant without rewriting source case", () => {
  const text = modelContextText(technicalModelContext.parse(selected));
  expect(text).toContain("aB-220");
  expect(text).toContain("220V");
  expect(text).toContain("Завод");
});
it("distinguishes a manual passport check from a confirmed model selection", () => {
  const text = modelContextText({ state: "unselected", revision: 0, usable: false });
  expect(text).toContain("вручную по паспорту");
  expect(text).toContain("не подтверждает выбор модели");
});
it.each(["stale", "excluded"] as const)("does not promise approval for %s evidence", (state) => {
  expect(modelContextText({ ...selected, state, usable: false })).toContain(
    "Подтвердить характеристики пока нельзя",
  );
});
it("shows both the captured and changed identity with a recovery action", () => {
  const text = modelBindingText({
    captured: selected,
    current: { ...selected, revision: 4, identity: { ...selected.identity, model: "MODEL-B" } },
    matches: false,
  });
  expect(text).toContain("aB-220");
  expect(text).toContain("MODEL-B");
  expect(text).toContain("Отмените черновик");
  expect(text).toContain("подтверждение недоступно");
});
it("does not label a pre-migration session as model-bound", () => {
  expect(modelBindingText(undefined)).toContain("старом черновике");
  expect(modelBindingText({ captured: null, current: selected, matches: false })).toContain(
    "начните проверку заново",
  );
});
it.each([
  { ...selected, usable: false },
  { ...selected, identity: null },
  { ...selected, choice_id: undefined },
  { ...selected, state: "stale" },
])("fails closed on contradictory model metadata", (v) => {
  expect(technicalModelContext.safeParse(v).success).toBe(false);
});
