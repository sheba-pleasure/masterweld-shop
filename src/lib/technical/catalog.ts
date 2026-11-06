import { queryOptions } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { publicTechnicalCard, type PublicTechnicalCard } from "./schema";

export async function readProductTechnical(productId: string): Promise<PublicTechnicalCard | null> {
  if (!z.string().uuid().safeParse(productId).success) throw new Error("TECH_INVALID_PRODUCT");
  const rpc = supabase.rpc.bind(supabase) as unknown as (
    name: "public_product_technical",
    args: { p_product_id: string },
  ) => Promise<{ data: unknown; error: unknown }>;
  const { data, error } = await rpc("public_product_technical", { p_product_id: productId });
  if (error) throw new Error("TECH_READ_UNAVAILABLE");
  if (data === null) return null;
  const result = publicTechnicalCard.safeParse(data);
  if (!result.success || result.data.product_id !== productId)
    throw new Error("TECH_INVALID_RESPONSE");
  return result.data;
}

export const productTechnicalQuery = (productId: string) =>
  queryOptions({
    queryKey: ["product-technical", productId],
    queryFn: () => readProductTechnical(productId),
  });
