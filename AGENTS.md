<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- Shop catalog lives in Cloud tables (categories with parent_id, products, product_photos, product_costs). Purchase costs sit in product_costs with no public access, so sellers and shoppers never see them.
- Storefront reads only published products through the public client; all staff writes go through the Telegram bot webhook (server-side, service role) after checking the staff table. This keeps one write path that can be audited.
- Shopper orders use the createOrder server function with server-side validation and price recalculation; legacy public INSERT must be closed by reviewed migration 0004 before launch. Confirmed READ ONLY 25.10.2026 (подтверждено READ ONLY 25.10.2026): shop_orders exists, anon retains INSERT privilege, and the INSERT policy "Shoppers can place an order" allows anon/authenticated with WITH CHECK. The bypass remains open; migration history and uninspected metadata are not established by this check.
- Bot role rules live in src/lib/bot/permissions.ts and have tests; change them there only.
- The bot dispatcher gates every update by actual private-chat sender and staff identity before service access; status/elevation writes require audited RPCs (review-only 0010), and webhook claims are retained on failure to prevent unsafe mutation replay.
- CartRows owns compact cart item presentation and quantity/removal controls; SiteActions keeps checkout submission and price-confirmation state so layout changes do not duplicate order logic.
- B2B inbound lives separately in src/lib/b2b and review-only CRM migration 0009; its authenticated ingestion route defaults to dry-run with live persistence disabled, and no email transport exists, preventing accidental mail delivery.
- B2B readers reuse staff permissions and actual sender/private-chat gating before opening their store; bounded server pagination and HEAD-only counts expose allowlisted metadata only after successful read and audit. Economics additionally requires view_costs; original email content never enters bot responses or logs.
- The shop sets robots noindex in the root route until indexing is deliberately enabled, so it does not compete with the old masterweld.ru for the same search queries.
