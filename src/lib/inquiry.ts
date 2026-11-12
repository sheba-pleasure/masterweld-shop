import { CONTACTS } from "@/lib/contacts";

export function inquiryHref(
  title: string,
  slug: string,
  sku?: string | null,
  origin?: string | null,
) {
  const link = origin
    ? `\nКарточка: ${new URL(`/product/${encodeURIComponent(slug)}`, origin).href}`
    : "";
  const article = sku ? `\nАртикул: ${sku}` : "";
  return `mailto:${CONTACTS.email}?subject=${encodeURIComponent(`Запрос цены: ${title}`)}&body=${encodeURIComponent(`Здравствуйте! Прошу уточнить цену, наличие и условия поставки: ${title}.${article}${link}`)}`;
}
