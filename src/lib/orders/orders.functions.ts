import { createServerFn } from "@tanstack/react-start";
import {
  orderPayloadSchema,
  computeOrder,
  checkExpectedPrice,
  type OrderProductRow,
  type OrderSnapshotItem,
} from "./schema";
import { peekOrderRateLimit, recordOrderHit } from "./rate-limit.server";

export interface CreateOrderResult {
  ok: boolean;
  /** PRICE_CHANGED — цены изменились; заказ НЕ записан, нужно подтверждение. */
  code?: "PRICE_CHANGED";
  /** Безопасный короткий номер заказа (только для показа покупателю). */
  number?: string;
  total?: number;
  /** Проверенные строки заказа (только published-товары, без PII) — для «было → стало». */
  items?: OrderSnapshotItem[];
  hasBackorder?: boolean;
  message?: string;
}

/**
 * Публичная серверная точка оформления заказа.
 * Покупатель передаёт только name/phone/comment и позиции {product_id, qty}.
 * Цены, состав и сумма пересчитываются на сервере по published-товарам;
 * клиентским price/title/total не доверяем.
 * Запись в shop_orders — только через service_role (см. миграцию 0004,
 * которая закрывает прямой INSERT из браузера после развёртывания).
 */
export const createOrder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => orderPayloadSchema.parse(input))
  .handler(async ({ data }): Promise<CreateOrderResult> => {
    // Анти-спам: ad-hoc лимит в памяти воркера (best-effort, не штатный primitive).
    // peek не расходует окно: PRICE_CHANGED (честное подтверждение цены) не
    // блокирует повторную попытку; счётчик растёт только при реальной записи.
    const key = `phone:${data.phone.replace(/\D/g, "")}`;
    if (!peekOrderRateLimit(key)) {
      return {
        ok: false,
        message: "Слишком много заказов подряд. Позвоните нам — примем по телефону.",
      };
    }

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const ids = [...new Set(data.items.map((i) => i.product_id))];
    const { data: rows, error: readErr } = await supabaseAdmin
      .from("products")
      .select("id, slug, title, price, status, in_stock")
      .in("id", ids);
    if (readErr) {
      console.error(`[orders] product read failed: ${readErr.message}`);
      return { ok: false, message: "Заказ не ушёл. Позвоните нам — примем по телефону." };
    }

    const computed = computeOrder(data, (rows ?? []) as OrderProductRow[]);
    if (!computed.ok) {
      return { ok: false, message: computed.message };
    }

    // Сверка с ожиданием покупателя (сумма/цены, которые он видел). Заказ не
    // пишется при расхождении: возвращаем актуальную сумму и проверенные строки,
    // UI показывает «было → стало» и ждёт явного повторного подтверждения.
    const expectedCheck = checkExpectedPrice(computed, data.expected);
    if (!expectedCheck.ok) {
      return {
        ok: false,
        code: "PRICE_CHANGED",
        total: computed.total,
        items: computed.items,
        hasBackorder: computed.hasBackorder,
        message: "Цены изменились с момента добавления в корзину. Подтвердите новую сумму.",
      };
    }

    const { data: inserted, error: insErr } = await supabaseAdmin
      .from("shop_orders")
      .insert({
        name: data.name,
        phone: data.phone,
        comment: data.comment ?? null,
        total: computed.total,
        items: computed.items as never,
      })
      .select("id")
      .single();
    if (insErr || !inserted) {
      console.error(`[orders] insert failed: ${insErr?.message ?? "no row"}`);
      return { ok: false, message: "Заказ не ушёл. Позвоните нам — примем по телефону." };
    }

    // Заказ реально записан — только теперь расходуем окно анти-спама.
    recordOrderHit(key);

    return {
      ok: true,
      number: `#${inserted.id.slice(0, 8)}`,
      total: computed.total,
      hasBackorder: computed.hasBackorder,
    };
  });
