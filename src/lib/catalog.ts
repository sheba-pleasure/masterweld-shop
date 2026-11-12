import { queryOptions } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface Photo {
  url: string;
  sort_order: number;
  is_main: boolean;
}
export interface ProductCard {
  id: string;
  slug: string;
  title: string;
  brand: string | null;
  sku: string | null;
  price: number | null;
  old_price: number | null;
  in_stock: boolean;
  category_id: string | null;
  product_photos: Photo[];
}

export const categoriesQuery = queryOptions({
  queryKey: ["categories"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("categories")
      .select("id,slug,name,sort_order,parent_id")
      .order("sort_order");
    if (error) throw error;
    return data;
  },
});

export const productsQuery = queryOptions({
  queryKey: ["products"],
  queryFn: async () => {
    const all: ProductCard[] = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("products")
        .select(
          "id,slug,title,brand,sku,price,old_price,in_stock,category_id,product_photos(url,sort_order,is_main)",
        )
        .eq("status", "published")
        .order("title")
        .range(from, from + 999);
      if (error) throw error;
      all.push(...(data as unknown as ProductCard[]));
      if (!data || data.length < 1000) break;
    }
    return all;
  },
});

export const productQuery = (slug: string) =>
  queryOptions({
    queryKey: ["product", slug],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("products")
        .select("*, categories(name,slug), product_photos(url,sort_order,is_main)")
        .eq("slug", slug)
        .eq("status", "published")
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

export const mainPhoto = (photos: Photo[] | undefined) =>
  [...(photos ?? [])].sort(
    (a, b) => Number(b.is_main) - Number(a.is_main) || a.sort_order - b.sort_order,
  )[0]?.url;

export const rub = (n: number | null) =>
  n === null ? "Цена по запросу" : new Intl.NumberFormat("ru-RU").format(Math.round(n)) + " ₽";
