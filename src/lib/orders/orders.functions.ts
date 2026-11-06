import { createServerFn } from "@tanstack/react-start";
import { submissionSchema, type CreateOrderResult } from "./submission";
import { peekOrderRateLimit, recordOrderHit } from "./rate-limit.server";

export type { CreateOrderResult } from "./submission";

/** Service-only persistence: a durable request ID commits order and receipt together. */
export const createOrder = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => submissionSchema.parse(input))
  .handler(async ({ data }): Promise<CreateOrderResult> => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { submitOrder, AttemptConflict } = await import("./submit.server");
    // Reviewed migration RPCs are absent from the historical Cloud-generated types.
    const rpc = async (name: string, args: Record<string, unknown>) => {
      const { data: result, error } = await supabaseAdmin
        .rpc(name as never, args as never)
        .abortSignal(AbortSignal.timeout(10_000));
      if (error) {
        if (error.message.includes("ORDER_ATTEMPT_CONFLICT")) throw new AttemptConflict();
        throw new Error("ORDER_STORAGE_UNAVAILABLE");
      }
      return result as CreateOrderResult | null;
    };
    return submitOrder(
      data,
      {
        lookup: (id, hash) =>
          rpc("lookup_order_submission", { p_request_id: id, p_payload_hash: hash }),
        async products(ids) {
          const { data: rows, error } = await supabaseAdmin
            .from("products")
            .select("id,slug,title,price,status,in_stock")
            .in("id", ids)
            .abortSignal(AbortSignal.timeout(10_000));
          if (error) throw new Error("ORDER_PRODUCTS_UNAVAILABLE");
          return rows ?? [];
        },
        async commit(attempt, hash, order, rejection) {
          const result = await rpc("commit_order_submission", {
            p_request_id: attempt.requestId,
            p_payload_hash: hash,
            p_name: attempt.name,
            p_phone: attempt.phone,
            p_comment: attempt.comment ?? null,
            p_items: order?.items ?? null,
            p_total: order?.total ?? null,
            p_has_backorder: order?.hasBackorder ?? null,
            p_rejection: rejection ?? null,
          });
          if (
            !result ||
            (result.ok
              ? !result.number
              : !["REJECTED", "PRICE_CHANGED"].includes(result.code ?? ""))
          )
            throw new Error("ORDER_RECEIPT_UNAVAILABLE");
          return result;
        },
      },
      { allowed: peekOrderRateLimit, record: recordOrderHit },
    );
  });
