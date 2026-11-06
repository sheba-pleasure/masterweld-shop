import { expect, it } from "vitest";
import {
  editorAction as act,
  editorReply as reply,
  editorData,
  families,
  fields,
  type EditorData,
} from "./editor";
const empty = (): EditorData => ({
  document: null,
  screen: "home",
  page: 0,
  field: null,
  fact: null,
  pending: null,
  source: null,
  sourceField: 0,
});
function family(code: string) {
  return act(
    act(empty(), "families"),
    "family",
    families.findIndex((f) => f.code === code),
  );
}
function field(s: EditorData, code: string, process = 0) {
  s = act(s, "fields");
  s = act(
    s,
    "field",
    fields(s).findIndex((f) => f.attribute_code === code),
  );
  return act(act(s, "process", process), "new");
}
function source(s: EditorData, kind = 1) {
  s = act(act(s, "newsource"), "kind", kind);
  for (const text of [
    "Учебная организация",
    "[Учебный] MODEL",
    "[Учебный] Не паспорт",
    "https://example.invalid/manual",
    "стр. 2",
    "2026-01-01",
  ])
    s = reply(s, text);
  return s;
}
it("collects mode, duty current and temperature before accepting a source; retains the draft across JSON round trips", () => {
  let s = field(family("power_mig"), "mig_duty_cycle_pct");
  s = reply(s, "60");
  expect(s.screen).toBe("context");
  s = reply(editorData.parse(JSON.parse(JSON.stringify(s))), "200");
  expect(s.screen).toBe("context");
  s = source(reply(s, "40"));
  expect(s.document?.values[0]).toMatchObject({
    value: 60,
    process: "mig",
    context: { current_a: 200, temperature_c: 40 },
  });
});
it("keeps false, zero and unknown distinct", () => {
  let s = source(reply(field(family("power_tig_dc"), "tig_pulse"), "нет"));
  expect(s.document?.values[0]?.value).toBe(false);
  s = act(field(s, "tig_current_max_a"), "unknown");
  expect(s.document?.values[1]).toMatchObject({ state: "unknown", value: null, source_key: null });
  s = reply(field(s, "tig_current_min_a"), "0");
  s = act(s, "source", 0);
  expect(s.document?.values[2]?.value).toBe(0);
});
it("same family selection preserves facts; a different family requires explicit clearing confirmation", () => {
  const s = source(reply(field(family("power_tig_dc"), "tig_pulse"), "да"));
  expect(
    act(
      act(s, "families"),
      "family",
      families.findIndex((f) => f.code === "power_tig_dc"),
    ).document,
  ).toEqual(s.document);
  const next = act(
    act(s, "families"),
    "family",
    families.findIndex((f) => f.code === "power_mma"),
  );
  expect(next.screen).toBe("family_change");
  expect(next.document).toEqual(s.document);
  expect(act(next, "family_yes").document?.values).toEqual([]);
});
it("adds different conditions without overwriting; identical conditions are rejected", () => {
  let s = source(
    reply(reply(reply(field(family("power_mig"), "mig_duty_cycle_pct"), "60"), "200"), "40"),
  );
  s = act(reply(reply(reply(field(s, "mig_duty_cycle_pct"), "100"), "150"), "40"), "source", 0);
  expect(s.document?.values).toHaveLength(2);
  const duplicate = reply(reply(reply(field(s, "mig_duty_cycle_pct"), "90"), "150"), "40");
  expect(() => act(duplicate, "source", 0)).toThrow("уже есть");
  expect(s.document?.values[0]?.value).toBe(60);
});
it("edits only the selected fact and keeps its existing conditions until explicitly changed", () => {
  let s = source(
    reply(reply(reply(field(family("power_mig"), "mig_duty_cycle_pct"), "60"), "200"), "40"),
  );
  s = act(s, "fields");
  s = act(
    s,
    "field",
    fields(s).findIndex((f) => f.attribute_code === "mig_duty_cycle_pct"),
  );
  s = act(act(s, "process"), "existing", 0);
  s = reply(s, "50");
  s = act(s, "source", 0);
  expect(s.document?.values).toHaveLength(1);
  expect(s.document?.values[0]).toMatchObject({
    value: 50,
    context: { current_a: 200, temperature_c: 40 },
  });
});
it("parses semicolon lists with decimal commas, rejects duplicates and malformed numbers", () => {
  const s = field(family("power_mig"), "mig_wire_diameters_mm");
  expect(reply(s, "0,8; 1,0").pending?.value).toEqual([0.8, 1]);
  for (const text of ["0.8;0,8", "NaN", "1e3", "0.8;;1", "0.8,1"])
    expect(() => reply(s, text)).toThrow();
});
it("enforces family enum restrictions and numeric bounds before persistence", () => {
  const s = field(family("power_tig_dc"), "tig_polarity_modes");
  expect(() => reply(s, "ac")).toThrow();
  expect(reply(s, "dc").pending?.value).toEqual(["dc"]);
  expect(() => reply(field(family("power_mig"), "mig_duty_cycle_pct"), "101")).toThrow();
});
it("does not accept a source URL with credentials or impossible/future date", () => {
  let s = act(
    act(reply(field(family("power_mma"), "mma_current_max_a"), "160"), "newsource"),
    "kind",
    1,
  );
  for (const text of ["QA", "model", "manual"]) s = reply(s, text);
  expect(() => reply(s, "https://example.invalid/doc?token=private")).toThrow();
  s = reply(reply(s, "https://example.invalid/doc"), "page 1");
  for (const date of ["2026-02-30", "9999-01-01", "01.01.2026"])
    expect(() => reply(s, date)).toThrow();
});
it("unknown removes measurement context and unused source, without mutating input", () => {
  let s = source(
    reply(reply(reply(field(family("power_mig"), "mig_duty_cycle_pct"), "60"), "200"), "40"),
  );
  const original = structuredClone(s);
  s = act(s, "fields");
  s = act(
    s,
    "field",
    fields(s).findIndex((f) => f.attribute_code === "mig_duty_cycle_pct"),
  );
  s = act(act(s, "process"), "existing", 0);
  s = act(s, "unknown");
  expect(s.document?.values[0]).toMatchObject({
    state: "unknown",
    value: null,
    context: {},
    source_key: null,
  });
  expect(s.document?.sources).toEqual([]);
  expect(original.document?.values[0]?.value).toBe(60);
});
it("cannot reply on home, reuse an unrelated action, or delete without confirmation", () => {
  const s = family("power_mma");
  expect(() => reply(s, "160")).toThrow();
  expect(() => act(s, "kind", 0)).toThrow();
  expect(() => act(s, "delete_yes", 0)).toThrow();
});
