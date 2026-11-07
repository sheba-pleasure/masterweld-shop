import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AnchorHTMLAttributes } from "react";
import type { CreateOrderResult, Submission } from "@/lib/orders/submission";
const mocks = vi.hoisted(() => ({ order: vi.fn(), reserve: vi.fn(), forget: vi.fn() }));
vi.mock("@/lib/orders/browser-attempt", () => ({
  reserveAttempt: (...args: unknown[]) => mocks.reserve(...args),
  forgetRejectedAttempt: (...args: unknown[]) => mocks.forget(...args),
}));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => mocks.order }));
vi.mock("@/lib/orders/orders.functions", () => ({ createOrder: vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params: _params,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & {
    to: string;
    params?: unknown;
  }) => <a href={to} {...props} />,
}));
import { SiteActions } from "./SiteActions";
import { addToCart, clearCart, openCart } from "@/lib/cart";
import { ATTEMPT_STORAGE_KEY } from "@/lib/orders/submission";

const item = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "test",
  title: "Учебный аппарат",
  price: 900,
  photo: null,
};
const success: CreateOrderResult = { ok: true, number: "#QA-123", total: 900, hasBackorder: false };
beforeEach(() => {
  vi.restoreAllMocks();
  mocks.order.mockReset();
  mocks.reserve
    .mockReset()
    .mockImplementation(async (attempt: Submission) => ({ attempt, reused: false }));
  mocks.forget.mockReset().mockResolvedValue(undefined);
  localStorage.clear();
  sessionStorage.clear();
  clearCart();
  addToCart(item);
  mocks.order.mockResolvedValue(success);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function checkout() {
  render(<SiteActions />);
  act(() => openCart());
  fireEvent.change(await screen.findByLabelText("Имя покупателя"), {
    target: { value: "Учебный покупатель" },
  });
  fireEvent.change(screen.getByLabelText("Телефон покупателя"), {
    target: { value: "+79990000001" },
  });
  const button = screen.getByRole("button", { name: /^Оформить (учебный )?заказ$/ });
  await waitFor(() => expect(button).toBeEnabled());
  fireEvent.click(button);
}

function blockAttemptRemoval(silent = false) {
  const remove = Storage.prototype.removeItem;
  let blocked = true;
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (
    this: Storage,
    key: string,
  ) {
    if (this === sessionStorage && key === ATTEMPT_STORAGE_KEY && blocked) {
      if (!silent) throw new DOMException("Test-only storage failure", "SecurityError");
      return;
    }
    return remove.call(this, key);
  });
  return () => {
    blocked = false;
  };
}

it.each([false, true])(
  "keeps a confirmed receipt after failed cleanup (silent=%s) and retries only local work",
  async (silent) => {
    const unblock = blockAttemptRemoval(silent);
    await checkout();
    expect(await screen.findByText("Заказ #QA-123 сохранён.")).toBeVisible();
    expect(screen.queryByText(/Заказ мог сохраниться/)).not.toBeInTheDocument();
    expect(screen.getByText(/Сумма заказа:/)).toHaveTextContent("900");
    expect(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)).not.toBeNull();
    expect(mocks.order).toHaveBeenCalledTimes(1);
    const original = JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)!) as Submission;
    fireEvent.click(screen.getByRole("button", { name: "Завершить в браузере" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Завершить в браузере" })).toBeEnabled(),
    );
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)!).requestId).toBe(
      original.requestId,
    );
    unblock();
    fireEvent.click(screen.getByRole("button", { name: "Завершить в браузере" }));
    expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("mw_cart_v1")).toBe("[]");
  },
);

it("preserves confirmation when cart storage fails before the attempt can be cleared", async () => {
  const write = Storage.prototype.setItem;
  let blocked = true;
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
    this: Storage,
    key: string,
    value: string,
  ) {
    if (this === localStorage && key === "mw_cart_v1" && value === "[]" && blocked)
      throw new DOMException("Test-only cart failure", "QuotaExceededError");
    return write.call(this, key, value);
  });
  await checkout();
  expect(await screen.findByText("Заказ #QA-123 сохранён.")).toBeVisible();
  expect(JSON.parse(localStorage.getItem("mw_cart_v1")!)).toHaveLength(1);
  expect(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)).not.toBeNull();
  blocked = false;
  fireEvent.click(screen.getByRole("button", { name: "Завершить в браузере" }));
  expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
  expect(mocks.order).toHaveBeenCalledTimes(1);
  expect(localStorage.getItem("mw_cart_v1")).toBe("[]");
});

it.each(["PRICE_CHANGED", "REJECTED"] as const)(
  "keeps definite %s separate from an unknown outcome during failed cleanup",
  async (code) => {
    const unblock = blockAttemptRemoval();
    mocks.order.mockResolvedValue({
      ok: false,
      code,
      message: "Проверьте состав заказа.",
      total: 950,
      items: [{ product_id: item.id, title: item.title, price: 950 }],
    });
    await checkout();
    expect(
      await screen.findByText(
        code === "PRICE_CHANGED" ? "Цены изменились — заказ не оформлен." : "Заказ не оформлен.",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/Заказ мог сохраниться/)).not.toBeInTheDocument();
    unblock();
    fireEvent.click(screen.getByRole("button", { name: "Завершить в браузере" }));
    if (code === "PRICE_CHANGED")
      expect(
        await screen.findByRole("button", { name: "Согласиться с новой ценой и оформить" }),
      ).toBeVisible();
    else expect(await screen.findByText("Проверьте состав заказа.")).toBeVisible();
    expect(mocks.order).toHaveBeenCalledTimes(1);
    expect(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
    expect(JSON.parse(localStorage.getItem("mw_cart_v1")!)).toHaveLength(1);
  },
);

it("still recovers an actually unknown result using the same attempt ID", async () => {
  mocks.order.mockRejectedValueOnce(new Error("Response lost")).mockResolvedValue(success);
  await checkout();
  expect(await screen.findByText(/Заказ мог сохраниться/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Завершить в браузере" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Проверить и завершить заказ" }));
  expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
  expect(mocks.order).toHaveBeenCalledTimes(2);
  expect(mocks.order.mock.calls[0]![0].data).toEqual(mocks.order.mock.calls[1]![0].data);
});

it("reloads an unfinished local cleanup through the same persisted attempt", async () => {
  const unblock = blockAttemptRemoval();
  await checkout();
  expect(await screen.findByText("Заказ #QA-123 сохранён.")).toBeVisible();
  const original = JSON.parse(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)!) as Submission;
  cleanup();
  unblock();
  render(<SiteActions />);
  act(() => openCart());
  fireEvent.click(await screen.findByRole("button", { name: "Проверить и завершить заказ" }));
  expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
  expect(mocks.order).toHaveBeenCalledTimes(2);
  expect(mocks.order.mock.calls[1]![0].data.requestId).toBe(original.requestId);
  expect(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
});

it("does not send or save a new local attempt when shared reservation fails", async () => {
  mocks.reserve.mockRejectedValue(new Error("Storage unavailable"));
  await checkout();
  expect(await screen.findByText(/Не удалось безопасно проверить/)).toBeVisible();
  expect(mocks.order).not.toHaveBeenCalled();
  expect(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)).toBeNull();
});

it("requires separate confirmation before another identical order", async () => {
  const previousId = "33333333-3333-4333-8333-333333333333";
  mocks.reserve.mockImplementationOnce(async (attempt: Submission) => ({
    attempt: { ...attempt, requestId: previousId },
    reused: true,
  }));
  await checkout();
  expect(await screen.findByText(/Второй заказ не создан/)).toBeVisible();
  expect(JSON.parse(localStorage.getItem("mw_cart_v1")!)).toHaveLength(1);
  expect(mocks.order.mock.calls[0]![0].data.requestId).toBe(previousId);
  fireEvent.click(screen.getByRole("button", { name: "Нужен ещё один заказ — проверить корзину" }));
  expect(screen.getByText(/Вы создаёте ещё один заказ/)).toBeVisible();
  expect(mocks.order).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: /^Оформить (учебный )?заказ$/ }));
  await waitFor(() => expect(mocks.order).toHaveBeenCalledTimes(2));
  expect(mocks.reserve.mock.calls[1]![1]).toEqual({ repeatOf: previousId });
  expect(mocks.order.mock.calls[1]![0].data.requestId).not.toBe(previousId);
  expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
});

it("keeps a definitive rejection when shared reservation cleanup fails", async () => {
  mocks.order.mockResolvedValue({
    ok: false,
    code: "REJECTED",
    message: "Проверьте состав заказа.",
  });
  mocks.forget.mockRejectedValueOnce(new Error("Storage unavailable")).mockResolvedValue(undefined);
  await checkout();
  expect(await screen.findByText("Заказ не оформлен.")).toBeVisible();
  expect(sessionStorage.getItem(ATTEMPT_STORAGE_KEY)).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Завершить в браузере" }));
  expect(await screen.findByText("Проверьте состав заказа.")).toBeVisible();
  expect(mocks.order).toHaveBeenCalledTimes(1);
  expect(mocks.forget).toHaveBeenCalledTimes(2);
});

it("blocks a new send while a shared reservation is still being persisted", async () => {
  let finish!: (value: { attempt: Submission; reused: boolean }) => void;
  let candidate!: Submission;
  mocks.reserve.mockImplementationOnce((attempt: Submission) => {
    candidate = attempt;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  await checkout();
  expect(mocks.reserve).toHaveBeenCalledTimes(1);
  const button = screen.getByRole("button", { name: /Отправляем/ });
  fireEvent.click(button);
  expect(mocks.reserve).toHaveBeenCalledTimes(1);
  expect(mocks.order).not.toHaveBeenCalled();
  await act(async () => finish({ attempt: candidate, reused: false }));
  expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
  expect(mocks.order).toHaveBeenCalledTimes(1);
});

it("refreshes the cart cleared elsewhere before completing a saved order", async () => {
  mocks.order.mockImplementationOnce(async () => {
    localStorage.setItem("mw_cart_v1", "[]");
    return success;
  });
  await checkout();
  expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
  expect(screen.getByLabelText("Корзина: 0 шт.")).toBeInTheDocument();
  expect(mocks.order).toHaveBeenCalledTimes(1);
});

it("preserves a different cart from another tab after completing a saved order", async () => {
  const other = {
    ...item,
    id: "22222222-2222-4222-8222-222222222222",
    title: "Другой товар",
    qty: 3,
  };
  mocks.order.mockImplementationOnce(async () => {
    localStorage.setItem("mw_cart_v1", JSON.stringify([other]));
    return success;
  });
  await checkout();
  expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
  expect(screen.getByLabelText("Корзина: 3 шт.")).toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem("mw_cart_v1")!)).toEqual([other]);
  expect(mocks.order).toHaveBeenCalledTimes(1);
});

it("does not reuse the previous confirmation for a new order with a lost response", async () => {
  await checkout();
  expect(await screen.findByText("Спасибо! Заказ #QA-123 принят.")).toBeVisible();
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  act(() => {
    addToCart(item);
    openCart();
  });
  mocks.order.mockRejectedValueOnce(new Error("New response lost"));
  fireEvent.click(await screen.findByRole("button", { name: /^Оформить (учебный )?заказ$/ }));
  expect(await screen.findByText(/Заказ мог сохраниться/)).toBeVisible();
  expect(screen.queryByText("Заказ #QA-123 сохранён.")).not.toBeInTheDocument();
  expect(mocks.order).toHaveBeenCalledTimes(2);
  expect(mocks.order.mock.calls[0]![0].data.requestId).not.toBe(
    mocks.order.mock.calls[1]![0].data.requestId,
  );
});
