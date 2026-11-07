import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider, onlineManager } from "@tanstack/react-query";
const mock = vi.hoisted(() => ({ rpc: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: mock.rpc } }));
import { ProductTechnical } from "./ProductTechnical";
const id = "10000000-0000-4000-8000-000000000001";
const source = {
  key: "manual",
  kind: "manual",
  publisher: "Изготовитель",
  model: "Учебная модель",
  title: "Учебный паспорт",
  url: "https://example.invalid/manual",
  locator: "Страница 2",
  checked_on: "2026-11-06",
  sha256: "",
};
const fact = {
  code: "mma_current_max_a",
  label: "Максимальный ток",
  kind: "number",
  process: "mma",
  state: "known",
  value: 160,
  unit: { code: "a", label: "А" },
  context: {},
  source_key: "manual",
};
const card = {
  product_id: id,
  revision_id: id,
  family: { code: "power_multiprocess", label: "Многопроцессный аппарат" },
  verified_on: "2026-11-06",
  sources: [source],
  values: [
    fact,
    { ...fact, code: "mig_current_max_a", process: "mig", value: 200 },
    {
      ...fact,
      code: "mig_duty_cycle_pct",
      label: "Продолжительность нагрузки",
      process: "mig",
      value: 60,
      unit: { code: "pct", label: "%" },
      context: { current_a: 200, temperature_c: 40 },
    },
    {
      ...fact,
      code: "tig_current_max_a",
      process: "tig",
      state: "unknown",
      value: null,
      source_key: null,
    },
  ],
};
let clients: QueryClient[] = [];
function mount(productId = id, legacySpecs: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  clients.push(client);
  const ui = (nextId: string) => (
    <QueryClientProvider client={client}>
      <ProductTechnical key={nextId} productId={nextId} legacySpecs={legacySpecs} />
    </QueryClientProvider>
  );
  return { ...render(ui(productId)), ui };
}
beforeEach(() => {
  mock.rpc.mockReset().mockResolvedValue({ data: card, error: null });
});
afterEach(() => {
  cleanup();
  clients.forEach((client) => client.clear());
  clients = [];
  onlineManager.setOnline(true);
});
it("shows mode-specific values, conditions, source and an explicit unknown", async () => {
  mount();
  expect(await screen.findByText("160 А")).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "MIG/MAG · Полуавтоматическая сварка" })).getByText(
      "200 А",
    ),
  ).toBeTruthy();
  expect(screen.getByText("Ток: 200 А")).toBeTruthy();
  expect(screen.getByText("Температура: 40 °C")).toBeTruthy();
  expect(screen.getByText("Не указано")).toBeTruthy();
  const summary = screen.getByText("Источники характеристик (1)");
  fireEvent.click(summary);
  expect(summary.closest("details")?.open).toBe(true);
  expect(screen.getByText("Страница 2")).toBeTruthy();
  const link = screen.getByRole("link", { name: "Открыть источник (новая вкладка)" });
  expect(link.getAttribute("rel")).toBe("noopener noreferrer");
});
it("labels synthetic facts as training and never links to a fictional passport", async () => {
  mock.rpc.mockResolvedValue({
    data: { ...card, sources: [{ ...source, kind: "synthetic" }] },
    error: null,
  });
  mount();
  expect(await screen.findByText(/Учебные данные — не паспорт товара/)).toBeTruthy();
  expect(screen.queryByText(/Проверено по источникам/)).toBeNull();
  expect(screen.queryByRole("link", { name: /Открыть источник/ })).toBeNull();
});
it("preserves old specs separately when verified data is absent", async () => {
  mock.rpc.mockResolvedValue({ data: null, error: null });
  mount(id, "Старое описание: 220 А\n\nВес: 4 кг");
  expect(await screen.findByText(/Проверенные характеристики пока не добавлены/)).toBeTruthy();
  fireEvent.click(screen.getByText("Характеристики из прежнего описания"));
  expect(screen.getByText("Старое описание: 220 А")).toBeTruthy();
  expect(screen.getByText(/проверка по источникам ещё не подтверждена/)).toBeTruthy();
});
it("hides stale verified values on failed refresh and recovers with the same button", async () => {
  mount();
  await screen.findByText("160 А");
  mock.rpc.mockResolvedValueOnce({ data: null, error: { message: "PRIVATE" } });
  fireEvent.click(screen.getByRole("button", { name: "Обновить характеристики" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.queryByText("160 А")).toBeNull();
  expect(screen.queryByText(/PRIVATE/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Обновить характеристики" }));
  await screen.findByText("160 А");
  expect(mock.rpc).toHaveBeenCalledTimes(3);
});
it("removes a cached card when a refresh says it is no longer public", async () => {
  mount();
  await screen.findByText("160 А");
  mock.rpc.mockResolvedValueOnce({ data: null, error: null });
  fireEvent.click(screen.getByRole("button", { name: "Обновить характеристики" }));
  await screen.findByText(/Проверенные характеристики пока не добавлены/);
  expect(screen.queryByText("160 А")).toBeNull();
});
it("never carries verified facts to the next product while its request is loading", async () => {
  const view = mount();
  await screen.findByText("160 А");
  let resolve!: (value: unknown) => void;
  mock.rpc.mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  view.rerender(view.ui("20000000-0000-4000-8000-000000000002"));
  await screen.findByRole("status");
  expect(screen.queryByText("160 А")).toBeNull();
  await waitFor(() => expect(mock.rpc).toHaveBeenCalledTimes(2));
  resolve({ data: null, error: null });
  await screen.findByText(/Проверенные характеристики пока не добавлены/);
});
it("explains an offline request instead of showing an endless loading state", async () => {
  onlineManager.setOnline(false);
  mount();
  expect(await screen.findByText(/Нет соединения/)).toBeTruthy();
  expect(mock.rpc).not.toHaveBeenCalled();
});
