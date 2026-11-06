import { orderPayloadSchema, type OrderPayload, type OrderSnapshotItem } from "./schema";
import { z } from "zod";

export const submissionSchema = orderPayloadSchema.extend({ requestId: z.string().uuid() });
export type Submission = z.infer<typeof submissionSchema>;
export interface CreateOrderResult {
  ok: boolean;
  code?: "PRICE_CHANGED" | "REJECTED" | "UNKNOWN" | "ATTEMPT_CONFLICT";
  number?: string;
  total?: number;
  items?: OrderSnapshotItem[];
  hasBackorder?: boolean;
  message?: string;
}
export const UNKNOWN_ORDER_MESSAGE =
  "Не удалось получить подтверждение. Заказ мог сохраниться. Нажмите «Проверить и завершить заказ» — повторного заказа не будет.";
export const ATTEMPT_STORAGE_KEY = "mw.checkout-attempt.v1";

export function canonicalPayload(data: OrderPayload): string {
  // Explicit properties: stable across serialization/reload; excludes request ID.
  return JSON.stringify({
    name: data.name,
    phone: data.phone,
    comment: data.comment ?? null,
    items: data.items.map((i) => ({ product_id: i.product_id, qty: i.qty })),
    expected: data.expected
      ? {
          total: data.expected.total,
          items: data.expected.items?.map((i) => ({
            product_id: i.product_id,
            unit_price: i.unit_price,
          })),
        }
      : null,
  });
}

export function loadAttempt(storage: Pick<Storage, "getItem">): Submission | null {
  const raw = storage.getItem(ATTEMPT_STORAGE_KEY);
  if (!raw) return null;
  // Corrupted storage must not silently turn an uncertain attempt into a new one.
  return submissionSchema.parse(JSON.parse(raw));
}
export function saveAttempt(storage: Pick<Storage, "setItem" | "getItem">, attempt: Submission) {
  const raw = JSON.stringify(submissionSchema.parse(attempt));
  storage.setItem(ATTEMPT_STORAGE_KEY, raw);
  if (storage.getItem(ATTEMPT_STORAGE_KEY) !== raw) throw new Error("ATTEMPT_STORAGE_FAILED");
}
