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
- Releases outside Lovable use the Dockerfile (Nitro node-server preset, which the Lovable sandbox ignores so preview stays intact) and ops/ blue/green scripts on loopback slots; scripts require an exact SHA merged to main with green verify, never touch the database, and keep the previous container for rollback; rollback runs offline from the local approved history and container labels, and release/rollback/build share one non-blocking flock so they never interleave. All changes go to DEV first. Only the owner's explicit «обнови main» authorizes promotion after a fresh release review. An unprotected main push is insufficient: deploy-production requires successful verify and a short-lived server approval for the exact main SHA. Automatic deployment is prepared, not yet provisioned. Native Git Sync is off; Git CLI is now authorized. Preserve current remote files and history when publishing. See docs/WORKFLOW.md and STATUS.md.

## Environment rules — 06.11.2026
- DEV: https://masterweld-dev.138-124-106-211.sslip.io, isolated masterweld_dev in mw-dev-db; no production data or token copies.
- Intended DEV bot: @testmw639bot. Check getMe and other active integrations before installing a webhook. @psinavsvaobot belongs to another project and must not be used.
- DEV migrations 0000–0011 were applied only to the new isolated database. Historical Cloud observations above remain historical; do not assume production was migrated.
- Runtime must verify APP_ENV, immutable build manifest and database instance identity. Never bypass these guards to make a deployment start.
- Never update main merely because work is complete. After «обнови main», report tests, blockers, omitted requirements, remaining work and the next priority; stop promotion on unresolved blockers.
- Before a DEV build, commit source; build.py archives that exact local commit. Documentation and runtime status must identify what is actually deployed.
- Do not claim unfinished import/photo/customer-account/payment/CRM flows are ready because routes or tables exist.
