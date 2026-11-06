import { createHash } from "node:crypto";
import {
  computeOrder,
  checkExpectedPrice,
  type OrderProductRow,
  type OrderSnapshotItem,
} from "./schema";
import {
  canonicalPayload,
  UNKNOWN_ORDER_MESSAGE,
  type Submission,
  type CreateOrderResult,
} from "./submission";

export interface SubmissionStore {
  lookup(id: string, hash: string): Promise<CreateOrderResult | null>;
  products(ids: string[]): Promise<OrderProductRow[]>;
  commit(
    data: Submission,
    hash: string,
    order: { items: OrderSnapshotItem[]; total: number; hasBackorder: boolean } | null,
    rejection?: CreateOrderResult,
  ): Promise<CreateOrderResult>;
}
export class AttemptConflict extends Error {}
export async function submitOrder(
  data: Submission,
  store: SubmissionStore,
  limit: { allowed(key: string): boolean; record(key: string): void },
): Promise<CreateOrderResult> {
  const hash = createHash("sha256").update(canonicalPayload(data)).digest("hex");
  try {
    // Recover a saved result BEFORE price/availability/rate-limit checks.
    const previous = await store.lookup(data.requestId, hash);
    if (previous) return previous;
    const key = "phone:" + data.phone.replace(/\D/g, "");
    if (!limit.allowed(key))
      return await store.commit(data, hash, null, {
        ok: false,
        code: "REJECTED",
        message: "Слишком много заказов подряд. Попробуйте позже или позвоните нам.",
      });
    const products = await store.products([...new Set(data.items.map((i) => i.product_id))]);
    const computed = computeOrder(data, products);
    if (!computed.ok)
      return await store.commit(data, hash, null, {
        ok: false,
        code: "REJECTED",
        message: computed.message,
      });
    if (!checkExpectedPrice(computed, data.expected).ok) {
      return await store.commit(data, hash, null, {
        ok: false,
        code: "PRICE_CHANGED",
        total: computed.total,
        items: computed.items,
        hasBackorder: computed.hasBackorder,
        message: "Цены изменились. Подтвердите новую сумму.",
      });
    }
    const result = await store.commit(data, hash, computed);
    limit.record(key);
    return result;
  } catch (error) {
    if (error instanceof AttemptConflict)
      return {
        ok: false,
        code: "ATTEMPT_CONFLICT",
        message:
          "Данные этой попытки отличаются от сохранённых. Не оформляйте заказ заново; свяжитесь с магазином и сообщите код попытки.",
      };
    // Reads may overlap an earlier in-flight write. Even a read error is uncertain.
    return { ok: false, code: "UNKNOWN", message: UNKNOWN_ORDER_MESSAGE };
  }
}
