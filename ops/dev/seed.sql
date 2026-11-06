-- Synthetic items only. No live staff, customer data, orders or supplier costs.
INSERT INTO public.categories(id,slug,name) VALUES
('10000000-0000-4000-8000-000000000001','dev-equipment','Учебное оборудование'),
('10000000-0000-4000-8000-000000000002','dev-consumables','Учебные расходники');
INSERT INTO public.products(id,slug,title,category_id,sku,price,in_stock,status,description) VALUES
('20000000-0000-4000-8000-000000000001','dev-welder','ТЕСТ — сварочный аппарат','10000000-0000-4000-8000-000000000001','DEV-001',10000,true,'published','Учебный товар. Не продаётся. Для проверки корзины и заказов.'),
('20000000-0000-4000-8000-000000000002','dev-mask','ТЕСТ — сварочная маска','10000000-0000-4000-8000-000000000002','DEV-002',2500,true,'published','Учебный товар. Не продаётся.'),
('20000000-0000-4000-8000-000000000003','dev-wire','ТЕСТ — проволока под заказ','10000000-0000-4000-8000-000000000002','DEV-003',900,false,'published','Учебный товар под заказ. Не продаётся.');
