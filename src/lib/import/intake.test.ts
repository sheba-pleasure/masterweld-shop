import { beforeEach, expect, it, vi } from "vitest";
import { parseIntakeCallback, renderIntake } from "./intake-view";
import type { StaffMember } from "@/lib/bot/permissions";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), tg: vi.fn(), download: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: { rpc: mocks.rpc } }));
vi.mock("@/lib/bot/telegram.server", () => ({ tg: mocks.tg }));
vi.mock("./telegram-file.server", () => ({ downloadIntakeDocument: mocks.download }));
import { receiveIntakeDocument, showIntake, enrollSellers } from "./intake.server";
const admin: StaffMember = {
  telegram_id: 101,
  name: "QA",
  role: "admin",
  active: true,
  elevated: false,
};
const chat = { id: 101, type: "private" };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({
    data: {
      ok: true,
      id: "11111111-1111-4111-8111-111111111111",
      state: "queued",
      file_name: "a.pdf",
    },
    error: null,
  });
  mocks.download.mockResolvedValue(new TextEncoder().encode("original"));
  mocks.tg.mockResolvedValue({});
});
it("denies documents and enrollment before storage/download for sellers, inactive and forged actors", async () => {
  for (const m of [
    { ...admin, role: "seller" as const },
    { ...admin, active: false },
  ]) {
    await receiveIntakeDocument(m, chat, { file_name: "a.pdf" });
    await showIntake(m, chat);
    await enrollSellers(m, chat, ["201"], "request");
  }
  await receiveIntakeDocument(admin, { id: 102, type: "private" }, { file_name: "a.pdf" });
  expect(mocks.rpc).not.toHaveBeenCalled();
  expect(mocks.download).not.toHaveBeenCalled();
});
it("uploads original only and does not publish or apply", async () => {
  await receiveIntakeDocument(admin, chat, { file_name: "a.pdf" });
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_document_intake", {
    p_actor: 101,
    p_op: "upload",
    p_payload: { file_name: "a.pdf", base64: "b3JpZ2luYWw=" },
  });
  expect(mocks.tg.mock.calls[0]![1].text).toContain("Оригинал");
});
it("shows recovery after unknown upload without replay", async () => {
  mocks.rpc.mockRejectedValue(new Error("private secret"));
  await receiveIntakeDocument(admin, chat, { file_name: "a.pdf" });
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
  expect(mocks.tg.mock.calls[0]![1].text).toContain("/documents");
  expect(JSON.stringify(mocks.tg.mock.calls)).not.toContain("private secret");
});
it("enrolls only requested sellers with stable request key", async () => {
  await enrollSellers(admin, chat, ["201", "202"], "stable-request");
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("bot_enroll_sellers", {
    p_actor: 101,
    p_request_key: "stable-request",
    p_ids: [201, 202],
  });
});
it("rejects malformed IDs and callback injection", async () => {
  await enrollSellers(admin, chat, ["-1", "1.5"], "request");
  expect(mocks.rpc).not.toHaveBeenCalled();
  for (const value of [
    "di:get:../../secret",
    "di:table:11111111-1111-4111-8111-111111111111:-1",
    "di:approve:all",
  ])
    expect(parseIntakeCallback(value)).toBeNull();
});
it("paginates large extracted documents without losing table identities", () => {
  const view = renderIntake(
    {
      ok: true,
      id: "11111111-1111-4111-8111-111111111111",
      state: "review",
      extraction: {
        tables: Array.from({ length: 100 }, (_, i) => ({
          label: String(i),
          header: ["sku", "price"],
          rows: [["A", "10"]],
        })),
        blocks: [],
        warnings: [],
        coverage: { complete: true },
      },
    },
    12,
  );
  const buttons = view.rows.flat();
  expect(buttons.length).toBeLessThan(20);
  expect(buttons.some((b) => b.callback_data.endsWith(":99"))).toBe(true);
  expect(view.text).toContain("13 из 13");
  expect(parseIntakeCallback("di:get:11111111-1111-4111-8111-111111111111:12")?.page).toBe(12);
});
it("review UI exposes missing coverage and no automatic publication", () => {
  const view = renderIntake({
    ok: true,
    id: "11111111-1111-4111-8111-111111111111",
    state: "review",
    extraction: {
      tables: [{ label: "Страница 1", header: ["sku", "price"], rows: [["", ""]] }],
      blocks: [],
      warnings: ["OCR_REVIEW"],
      coverage: { complete: false, pages: 2, processed: 1 },
    },
  });
  expect(view.text).toContain("1 из 2");
  expect(view.text).toContain("сверка с оригиналом");
  expect(view.rows.flat().some((b) => b.callback_data.startsWith("di:table:"))).toBe(true);
  expect(JSON.stringify(view)).not.toContain("ci:apply");
});
