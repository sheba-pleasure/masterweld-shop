-- Orders placed from the storefront cart.
-- Shoppers may only insert an order; reading orders back is staff-only (Telegram bot uses service_role).
CREATE TABLE public.shop_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  phone text NOT NULL,
  comment text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total numeric(12,2) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT INSERT ON public.shop_orders TO anon, authenticated;
GRANT ALL ON public.shop_orders TO service_role;
ALTER TABLE public.shop_orders ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Shoppers can place an order" ON public.shop_orders FOR INSERT TO anon, authenticated
  WITH CHECK (
    char_length(btrim(name)) BETWEEN 2 AND 200
    AND char_length(btrim(phone)) BETWEEN 5 AND 40
    AND (comment IS NULL OR char_length(comment) <= 1000)
    AND total >= 0 AND total < 100000000
    AND jsonb_typeof(items) = 'array'
    AND jsonb_array_length(items) BETWEEN 1 AND 200
  );