import type { PublicTechnicalCard } from "./schema";

export type DocumentCard = Pick<PublicTechnicalCard, "sources" | "verified_on"> & {
  review_status?: "verified" | "manufacturer_source_unverified" | undefined;
};

/** Reuse the existing model-bound, withdrawal-aware public read path.
 * Discovery candidates never become public document links through this helper.
 * Technical verification does not assert that a certificate is still valid.
 */
export function productDocuments(card: DocumentCard | null | undefined) {
  if (!card || card.review_status === "manufacturer_source_unverified" || !card.verified_on)
    return [];
  const urls = new Set<string>();
  return card.sources.filter((source) => {
    if (!["manual", "test_report", "manufacturer"].includes(source.kind)) return false;
    let url: URL;
    try { url = new URL(source.url); } catch { return false; }
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      return false;
    const document = source.kind === "manual" || source.kind === "test_report" ||
      /\.(pdf|docx?)$/i.test(url.pathname) || url.pathname.startsWith("/docs/");
    if (!document || urls.has(url.href)) return false;
    urls.add(url.href);
    return true;
  });
}
