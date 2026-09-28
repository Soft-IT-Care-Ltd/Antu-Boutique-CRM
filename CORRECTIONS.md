# Antu Boutique — Corrections & New Requirements (Round 1)

**Raised by:** the owner, 28 Sep 2026, after Phase 5.2 (19 points, numbered as the owner gave them).
**Status of the ERP when raised:** Phases 0–4 and P5.1–P5.2 built, verified and pushed. P5.3 (deploy) not started.

How to use this file:
- The **Build order** section has the prompts, in order. Paste one at a time into Claude Code.
- Each prompt points at **items** below. The items are the spec — read the item, not a summary of it.
- When an item is built, mark it `[DONE]` with a one-line note of what was built and the commit.
- **Read "Changes to existing rules" before any prompt.** Several items deliberately change rules written earlier in PRD.md; the PRD must be updated in the same commit.

---

## Decisions already made by the owner (28 Sep 2026)

| Question | Decision |
|---|---|
| What does the Dorji (tailoring) showroom sell? | **Stitching / tailoring charges only** — a service, no stock. |
| Which location packs online orders and hands them to the courier? | **Mohammadpur Warehouse** is the packing hub. Other locations transfer items to it. |
| How do website customers pay? | **Cash on Delivery only** (online payment can be added later). |
| How is the website delivery charge chosen? | **Two big buttons: "ঢাকার ভিতরে" / "ঢাকার বাইরে"**, each with its charge from Settings. No district/thana fields. |
| Where is there a POS? | **Only at the Shyamoli showroom — one POS** that bills both dresses and tailoring (Dorji). Tailoring services with their rates are selectable in the same POS. Parlour Sales Corner, Studio and Mohammadpur hold stock only. |
| Scanners | **Every warehouse/location gets a barcode scanner** so staff can scan what goes out and what comes in. |
| Item 19 (SKU pattern) | **Dropped** — after seeing how the current system works, the owner keeps the P3.1 short-SKU format. Do not build C1. |
| Packers can't find dresses in the warehouse (item 20) | Add **shelf/box locations inside each warehouse**, scan-based put-away, pick lists sorted by shelf, and a "not found" button — new prompt C4b. |

## Defaults assumed (owner can change any of these)

- Website shows a product as orderable only when it is in stock somewhere, unless the product has **"Allow pre-order on website"** switched on (then it can be ordered and becomes a backorder, item 12).
- Website and landing-page orders arrive as **Needs confirmation**; an SE calls the customer before the order goes to packing (standard for COD in Bangladesh — it filters fake orders).
- Website and landing-page orders are **not credited to any SE's target** by default (setting).
- Membership discount and an offer price **do not stack** — the customer gets the better of the two.
- Offer prices apply on **website and online orders** by default; POS is a checkbox per offer.
- Meta Purchase event fires **at order placement** by default; setting to fire it at SE confirmation instead.

---

## Changes to existing rules — read before every prompt

These items change rules already written in PRD.md. Update the PRD sections named here in the same commit as the change.

1. **Stock becomes per location** (items 2, 4, 11). Stock is held per *(variant, location)*; total stock is the sum. Every ledger row carries a location. The invariant becomes: *for each variant at each location, stock = sum of that location's ledger rows*. Courier returns restock at the packing hub; counter exchanges restock at that showroom's location; purchases choose a location. (PRD §4.3, §6)
2. **Selling without stock** (items 11, 12). PRD §6 invariant 7 ("selling below available stock is blocked") changes: **online orders may be taken for items with no stock** — those lines become backorders. **POS** may sell an item the system shows as 0 at that location (the item is physically in hand), with a warning; that location's stock goes negative and appears on a *Negative stock* alert for its manager. (PRD §4.6, §4.7, §6)
3. **Edits after Confirmed** (item 12). The rule "edits are refused once past Confirmed" gets one controlled exception: the **fulfilment actions** (substitute an item, remove an item, cancel for stock-out). Each needs a reason, is audit-logged, recomputes total and due, and regenerates the invoice as a new version (invariant 8). Free editing stays blocked. (PRD §4.6)
4. **Tailoring on the POS** (item 10). The one POS and its one cash drawer stay as they are (Shyamoli). Tailoring services are added to the same POS as a new kind of item with no stock, and every POS report splits dress sales from tailoring. (PRD §4.7)
5. **SKU format — unchanged** (item 19 dropped). The P3.1 short-SKU format stays.
6. **Order source** (items 7, 8, 18). `channel` (ONLINE / WALK_IN) stays. A new `source` field records where the order came from: Messenger, WhatsApp, Instagram, Phone, Website, Landing page (+ which page), Follow-up call, POS. (PRD §4.6)
7. **Packing checklist** (item 13). "Items match the order" becomes a real barcode scan of every unit. "Image matched" stays — the scan proves the SKU, the photo proves it is the design the customer asked for. (PRD §4.8)
8. **Availability** (items 2, 12, 13). Low-stock alerts and outfit-set availability use **total** stock across locations; packing needs every unit **at the hub**. (PRD §4.2, §4.3)

---

## Build order

Two releases are recommended:
- **Release 1 — the ERP with multi-location stock (C1–C8).** Go live with this (P5.3) so the shop, warehouses and online sales run on the system as early as possible.
- **Release 2 — the website, landing pages and tracking (C9–C12).** Built on top of a live ERP. Website problems then never block day-to-day operations.

The owner may choose to finish both before going live — the order of prompts is the same either way.

### C1 — SKU pattern — DROPPED, do not run

The owner keeps the current SKU format. Start at C2.

### C2 — Lists, date filters, order status tabs (start here)

```
Read CORRECTIONS.md items 14, 15 and 16.

Build one shared pagination component (item 15) and one shared date filter (item 16) and use them on every list and every report/dashboard in the app — search the codebase for every existing list and date filter and convert them all, don't leave old variants behind. Then rebuild the Orders page status navigation as item 14 describes. Dhaka time for all date ranges. Mark items [DONE], commit, merge, push.
```

### C3 — Locations and per-location stock (the foundation — biggest change)

```
Read CORRECTIONS.md → "Changes to existing rules" points 1, 2 and 8, then items 2, 4 and 11.

This changes how stock is stored everywhere, so plan it before writing code: list every place that reads or writes stock (orders, packing, POS, purchases, adjustments, returns, exchanges, outfit sets, packaging materials, reports, import, alerts) and show me the list with how each will change. Then build:
- locations, per-(variant, location) stock, location on every ledger row, location-scoped users (item 2)
- migrate existing dev stock to the Mohammadpur Warehouse location with ledger rows so the invariant holds
- per-location stock entry when adding a product, and a location on purchases, adjustments and the CSV import (item 4)
- POS deducting from its showroom's location, with the negative-stock warning and alert (item 11)
- stock lookup by SKU/name/scan showing every location (item 2)
(Purchase receiving by scan and stock count by scan from item 2 are built in C4, not here.)

The ledger test must now prove, for every variant at every location, stock = sum of ledger rows, after purchases, sales, POS sales, returns, exchanges, packing and adjustments. Update PRD §4.3 and §6. Mark items [DONE], commit, merge, push.
```

### C4 — Stock transfers between locations

```
Read CORRECTIONS.md item 3 (and item 13 for how transfers feed packing).

Build transfers exactly as item 3 describes: scan-to-send, in-transit, scan-to-receive, differences and their resolution, and the per-location "Needed at the packing hub" screen. Also build the two other scan flows from item 2: purchase receiving by scan, and stock count by scan. Every scan screen must work with a handheld USB/Bluetooth scanner (types the SKU + Enter) and with the phone camera as a fallback, and be usable on a phone. Stock in transit must stay counted in the total while belonging to no location. Test: stock = sum of ledger rows per location, and total stock unchanged, through send, receive, short receipt and a write-off. Mark item 3 [DONE], commit, merge, push.
```

### C4b — Shelf locations inside each warehouse

```
Read CORRECTIONS.md item 20. The real problem: packers can't find dresses that the system says are in stock, so orders don't ship.

Build shelf/box locations inside every location exactly as item 20 describes: shelf codes and printable shelf labels, put-away by scanning dress then shelf, moving between shelves, counting one shelf at a time, and the "Unassigned" bucket. Shelf quantities are a "where is it" layer inside a location — they must always add up to that location's stock, and they never change accounting or the stock ledger. Show the shelf everywhere a person needs to find a dress: stock lookup, the order screen, the packing panel. Mark item 20's C4b part [DONE], commit, merge, push.
```

### C5 — Fulfilment: backorders, automatic stock status, scan-to-pack

```
Read CORRECTIONS.md → "Changes to existing rules" points 2, 3 and 7, then items 12, 13 and 20 (the pick-list and "not found" parts).

Build:
- backorder lines on online orders and the "Waiting for stock" page (item 12)
- automatic fulfilment status (Ready to pack / Needs transfer / Waiting for stock), recomputed on every stock movement, with oldest-order-first allocation so two orders never count the same last piece (item 13)
- the four fulfilment actions — substitute, wait, remove item, cancel for stock-out — with reasons, audit log, recomputed totals and a new invoice version (item 12)
- the packing panel with bulk invoice print and scan-every-unit-before-Packed (item 13)
- the shelf-sorted pick list, the "Not found" button, and the stuck-order alert (item 20)

Test the race: two orders need the last unit of a variant — only the older one becomes Ready to pack. Test a set with one missing piece. Update PRD §4.6 and §4.8. Mark items [DONE], commit, merge, push.
```

### C6 — Tailoring on the POS, showroom reports

```
Read CORRECTIONS.md → "Changes to existing rules" point 4, then items 10 and 11.

Add tailoring services to the existing Shyamoli POS as item 10 describes: a service list with rates in Settings, selectable at the POS, no stock, billed on the same bill as dresses. Then build the showroom sales and payment-method report and dashboard section, with dress and tailoring shown separately everywhere. Keep the one POS and its one cash drawer. Update PRD §4.7. Mark items [DONE], commit, merge, push.
```

### C7 — Membership

```
Read CORRECTIONS.md item 17. Build membership plans, member cards, automatic member discount at POS and on online orders (no stacking with offers — the better one wins), the old-members CSV import, and the membership reports. Plan details are configurable in Settings — the owner will fill them in. Mark item 17 [DONE], commit, merge, push.
```

### C8 — Follow-up calling team

```
Read CORRECTIONS.md item 18. Build the follow-up role, campaigns, segment-based call lists with daily assignment, the call log, ordering from the call screen with source "Follow-up call", the incentive rule (counted only on delivered, not-returned orders), and the reports. Mark item 18 [DONE], commit, merge, push.
```

### Verify Round 1 — ERP

```
Reviewer pass on C1–C8. Verify by reading code and testing:
1. For every variant at every location, stock = sum of ledger rows, after a full day of: purchases into two locations, a transfer with a short receipt, online orders (including a backorder), packing by scan, POS sales in two showrooms (one at negative stock), a counter exchange, a courier return and a stock adjustment. Total stock = sum over locations + in transit.
2. Fulfilment status is right for an order whose items are: all at the hub / one at Shyamoli / one nowhere. Receiving a transfer or a purchase flips waiting orders oldest-first.
3. Packed cannot be pressed until every unit, including each outfit-set piece, is scanned; a wrong SKU is refused.
4. Substitute / remove / cancel-for-stock-out each recompute total and due, regenerate the invoice, and handle an advance larger than the new total (store credit or refund).
5. Showroom report: dress sales + tailoring sales = POS total, each payment method adds up to the day's collection, and the drawer balances. Tailoring never touches stock.
6. Member discount applies automatically and never stacks with an offer.
7. A follow-up sale that is later returned earns no incentive.
8. Every scan screen (transfer send/receive, purchase receiving, stock count, put-away, packing, POS) accepts a handheld scanner and a phone camera, and refuses a tag that doesn't belong.
8b. Shelf quantities always add up to their location's stock, through put-away, shelf moves, packing, POS sales, transfers and a "Not found". A "Not found" takes the order out of Ready to pack, flags the shelf for a recount and alerts the manager — the order is never silently left.
9. Role sweep: location managers act only on their own locations; SE, follow-up executive, packing and POS operator see no cost or profit anywhere.
Report findings, fix them, merge and push.
```

→ **Release 1 can now go live: run P5.3 (deploy) from BUILD_PROMPTS.md.**

### C9 — Website: storefront, checkout, orders into the ERP

```
Read CORRECTIONS.md → "Changes to existing rules" point 6, then items 1, 6 and 7.

Before building, propose the architecture (same app and database; public storefront on the main domain, ERP on a subdomain or /admin; public endpoints fully separated from ERP APIs) and wait for my OK.

Then build the storefront from the one shared catalog (item 1), the simple mobile-first checkout (item 6), and website orders flowing into the ERP as "Needs confirmation" with source Website and round-robin SE assignment (item 7). The public side must never expose cost, exact stock numbers, other customers, or any ERP route. Rate-limit order creation. Test on a phone-sized viewport and on iOS Safari 15.4+. Mark items [DONE], commit, merge, push.
```

### C10 — Website home page management

```
Read CORRECTIONS.md item 5. Build the home-page manager: banners, featured products, trending / hot selling, category showcases, limited-time offers with a live countdown and automatic price revert, and the offer banner — each section switchable on/off and reorderable, with a preview before publishing. Offer prices apply on the channels ticked on the offer. Mark item 5 [DONE], commit, merge, push.
```

### C11 — Landing pages

```
Read CORRECTIONS.md item 8. Build the landing-page builder with its blocks, the embedded order form, orders arriving with source "Landing page: <name>", and per-page visit/order/conversion stats. Mark item 8 [DONE], commit, merge, push.
```

### C12 — Meta Pixel + Conversions API (server-side tracking)

```
Read CORRECTIONS.md item 9. Build browser Pixel + server-side Conversions API with event deduplication, hashed customer data, the Settings screen (token encrypted and masked like the courier keys, never in .env or code), the test-event mode, the event log, and per-landing-page pixel override. Never send cost or internal notes. Verify deduplication with Meta's test events tool before calling it done. Mark item 9 [DONE], commit, merge, push.
```

### Verify Round 1 — Website

```
Reviewer pass on C9–C12:
1. A product added in the ERP appears on the website, at the POS and in SE order entry; switching it off hides it from the website only.
2. Place a website order and a landing-page order on a phone-sized viewport: each lands in the ERP as Needs confirmation with the right source, reserves stock, and follows the normal flow after confirmation.
3. An offer's countdown ends and the price reverts on every channel it was applied to, with no order left at the offer price after the end time.
4. The public site exposes no ERP route, no cost, no exact stock numbers and no other customer's data — try it with crafted requests.
5. Pixel and Conversions API events deduplicate in Meta's test tool; Purchase fires once per order at the configured moment.
6. Order spam: repeated orders from the same phone or IP are rate-limited and flagged.
Report findings, fix them, merge and push.
```

---

## Items

### 1. Website on the same catalog — [OPEN]
- **One product, everywhere.** A product added once in the ERP is sold on the website, at the POS and through SE order entry. There is no separate website product list.
- Product gets website fields: **Show on website** (on/off), **slug** (auto from the name, editable), website description, SEO title and description, display order. The first product image is the main image.
- The website shows only active products with *Show on website* on. Price = selling price, or the active offer price (item 5).
- **Stock on the website:** "In stock" when total available across all locations > 0 (never exact numbers). At 0 the product shows "Stock out" and can't be ordered — unless the product's **Allow pre-order on website** is on, in which case it shows "অর্ডার করা যাবে — স্টক আসলে পাঠানো হবে" and the order becomes a backorder (item 12).
- Same app and database as the ERP. The storefront is public; the ERP stays behind login. Public endpoints are separate from ERP APIs and return nothing beyond what the page needs.
- Fast on a mid-range Android phone on 4G: product pages cached and revalidated when the product changes, images resized and lazy-loaded.
- SEO basics: sitemap, page titles/descriptions, Open Graph images so links shared on Facebook/Messenger show a proper preview.

### 2. Multiple stock locations — [OPEN]
- **Locations** (Settings, Admin): name, type (Warehouse / Shop / Sales corner / Studio), address, **Packing hub** (exactly one), **Has POS**, active. More can be added any time.
- Start with: **Shyamoli Showroom** (shop, **the only POS**), **Mohammadpur Warehouse** (warehouse, **packing hub**), **Parlour Sales Corner** (stock only), **Studio** (stock only).
- **Scanners at every location.** Each location has a barcode scanner for what goes out and what comes in. Every screen that moves stock — transfer send and receive, purchase receiving, stock count, packing, POS — works with a handheld scanner (it types the SKU + Enter) and, as a fallback, the phone's camera.
- **Purchase receiving by scan:** new stock arriving at a location can be received by scanning the tags, not only by typing quantities.
- **Stock count by scan:** a manager can count a location by scanning everything on the shelf; the system shows counted vs expected per variant and posts the difference through a stock adjustment (Stock shortage rules).
- Stock is held per variant per location. Total stock = sum of locations (+ in transit, item 3).
- **Stock lookup:** type or scan a SKU, or search a name → every location's quantity, in transit, reserved and available. Usable from a phone.
- **Location managers / incharges:** users can be assigned to one or more locations; they see and act for their locations (receive transfers, send transfers, count stock). Admin and Manager see all.
- Reservations for online orders are against **total** available stock, not a location.

### 3. Stock transfers between locations — [OPEN]
- **Transfer** document: number `TR-YYMM-NNNN`, from location, to location, created by, lines (variant, qty sent, qty received), status **Draft → In transit → Received** (or **Received with difference**, **Cancelled**).
- **Sending:** the sender picks the destination and scans each tag (or types the SKU) — every scan adds one unit; the screen shows the running list; **Send** moves the stock out of the source into *In transit*. Items in transit count in total stock but belong to no location.
- **Receiving:** the destination's manager opens the incoming transfer and scans each unit as it's unpacked. **Receive** adds the scanned units to that location's stock.
- **Differences:** fewer units received than sent → the missing units stay "missing in transit" until a manager resolves them: *found* (receive later) or *write off* (expense at cost under "Stock shortage"). A scanned item that isn't on the transfer is refused with a clear message.
- Only the source location can send and only the destination can receive (Admin can do both).
- **"Needed at the packing hub"** screen, per location: every unpacked online order that has an item the hub doesn't have but *this* location does, with the quantity needed. The manager ticks items → one click creates a transfer to the hub, pre-filled and linked to those orders. When the hub receives it, those orders update automatically (item 13).

### 4. Stock entered per location when a product is added — [OPEN]
- Adding a product shows a **stock-in grid**: one row per size/colour, one column per location, plus a unit cost per row. Example: 5 at Shyamoli, 10 at Mohammadpur.
- Saving posts *opening stock* ledger rows per location in one transaction, and the unit cost becomes the variant's average cost. Stock is never typed into a stock field directly.
- After that, new stock comes in through **Purchase entry**, which now has a location per line (default: packing hub).
- The CSV import (Settings → Import) gets a location column.

### 5. Website home page manager — [OPEN]
- **Banners:** desktop image + mobile image, link, order, start/end date, on/off.
- **Featured products:** choose products by hand, or choose a category and how many to show.
- **Trending / Hot selling:** automatic (most units sold in the last N days) or chosen by hand.
- **Category showcases:** pick categories and how many products each shows.
- **Limited-time offer:** products + offer price (or % off) + start and end time. A live countdown shows on the site; at the end time the price **reverts automatically** everywhere. Each offer has channel checkboxes: Website, Online orders, POS (default: Website + Online orders).
- **Offer banner:** add, and switch on/off.
- Every section switchable on/off and reorderable; preview before publishing.

### 6. Simple checkout — [OPEN]
- One page. Fields: **Name, Phone, Address** (one box), **Note** (optional). No district/thana boxes.
- Delivery: two big buttons **"ঢাকার ভিতরে" / "ঢাকার বাইরে"**, each showing its charge from Settings.
- Payment: **Cash on Delivery** only.
- Phone must be a valid BD number (accept 01…, +8801…, 8801…; store 01XXXXXXXXX).
- Built for the actual customers — mostly women, mostly on phones: large text and tap targets, Bangla-first labels, one-handed use, clear size/colour selection on the product page (with an optional size-chart image), no account or login needed, cart kept if the page is closed.
- After ordering: a confirmation page with the order number and "আমাদের টিম আপনাকে কল করে অর্ডারটি কনফার্ম করবে".
- Spam protection without friction: rate limit per phone and per IP, a hidden honeypot field, and the same phone + same items within 30 minutes flagged as a likely duplicate. No captcha.

### 7. Website orders in the ERP — [OPEN]
- Website orders appear in the Orders page automatically, **source: Website**.
- They arrive as **Needs confirmation**, assigned round-robin to SEs on duty. The SE calls the customer and confirms, edits or cancels (reasons: fake / unreachable / changed mind / duplicate). Unconfirmed orders older than 48 hours are flagged.
- Stock is reserved at placement; a cancelled confirmation releases it.
- Not credited to any SE's target by default (setting in Settings).
- Source is a filter on the Orders page and a column in the sales report.

### 8. Custom landing pages — [OPEN]
- A builder with blocks: hero image or video, headline, text, image gallery, feature bullets, price box (with offer and countdown), FAQ, customer photos, and the **order form**.
- Any product(s) can be put on a page; the order form lets the customer pick size/colour and uses the item 6 checkout.
- URL `/lp/<slug>`; publish/unpublish.
- Orders arrive with **source: Landing page — <page name>** and go through item 7.
- Per page: visits, orders, conversion rate.
- Mobile-first; loads fast (it will be the target of paid ads).

### 9. Pixel with server-side tracking — [OPEN]
- **Meta Pixel** in the browser **plus the Conversions API** from the server, on the website and every landing page.
- Events: PageView, ViewContent, AddToCart, InitiateCheckout, Purchase. The browser and server copy of each event share an `event_id` so Meta counts it once.
- Customer data sent hashed (SHA-256) as Meta requires: phone normalised with country code, name, city; plus the fbp/fbc cookies, IP and browser user-agent.
- **Purchase** fires at order placement (default) or at SE confirmation (setting).
- Settings: Pixel ID, Conversions API token (encrypted, masked, never in .env or code), test event code, on/off. An event log (Admin) for debugging.
- A landing page can use a different Pixel ID.
- Never send cost, internal notes or anything beyond what Meta needs.
- Later, if wanted: TikTok Pixel + Events API, Google Analytics 4, and sending Messenger orders entered by SEs to Meta as conversions.

### 10. Tailoring on the POS and showroom sales reports — [OPEN]
- There is **one POS, at the Shyamoli showroom**. It bills both dresses and **tailoring (Dorji)**.
- **Tailoring services** (e.g. blouse stitching, salwar-kameez stitching, alteration, fall-pico) are a list with rates in Settings. At the POS the operator selects a service and its rate fills in (editable within limits). No stock, no price tag, no cost of goods.
- **One bill can contain both** dresses and tailoring — the customer pays once — but every report counts them separately.
- **Dashboard and reports:** POS total, **dress sales vs tailoring sales**, and collection by payment method (Cash, bKash, Nagad, Card), for any date range (item 16).
- The one cash drawer stays as it is.
- A POS sale deducts dress stock from the Shyamoli location (item 11).
- The design keeps room for a second showroom later, but no multi-showroom screens are built now.
- Not included now (ask if wanted): a tailoring job tracker — measurements, fabric received, ready-by date, delivered to customer.

### 11. POS sales reduce that location's stock — [OPEN]
- A POS sale deducts from the showroom's location, which is part of total stock.
- If the system shows 0 at that location but the item is physically in hand, the sale goes through with a warning; that location's stock goes negative and appears on a **Negative stock** alert for its manager to fix (count or transfer).

### 12. Online orders without stock (backorders) — [OPEN]
**Rule:** sales staff may take an online order even when an item is out of stock everywhere — customers order 2–3 dresses in one inbox conversation and the team must not lose the sale.
- Such lines are marked **backorder**; the order's fulfilment status becomes **Waiting for stock** (item 13).
- **"Waiting for stock" page:** every such order — customer, missing items (variant, qty), order value, days waiting — and totals: number of orders, total parcel value, and quantity needed per variant (printable, CSV, and pre-fills a purchase entry).
- **When stock arrives** (purchase, transfer received, return restocked), the system gives it to waiting orders **oldest first** and updates their status; packing and the order's SE are notified.
- **Fulfilment actions** on an order with a missing item — used by packing, a location incharge or the SE after calling the customer:
  1. **Substitute:** replace the missing item with another product/variant the customer agreed to. Total and due recomputed.
  2. **Wait:** the order stays in Waiting for stock (optional expected date) and ships when stock arrives.
  3. **Remove item:** drop the missing item and ship the rest. Total and due recomputed.
  4. **Cancel (single-item order):** cancel with a required reason.
  Every action needs a reason, is audit-logged, and regenerates the invoice as a new version. If the customer already paid more than the new total, the difference follows the P3.2 rules (store credit, or refund with approval).
- **Stock-out report:** value of items removed or orders cancelled because of stock-outs, by product — lost sales.

### 13. Packing panel and scan-to-pack — [OPEN]
- The packing team (Mohammadpur hub) sees orders the moment they are entered or confirmed: how many orders, how many items, which items.
- **Automatic fulfilment status** for every order, from stock:
  - **Ready to pack** — every unit is at the hub.
  - **Needs transfer** — some unit isn't at the hub but is at another location (named on the order). The order appears on that location's "Needed at the packing hub" screen (item 3) and flips to Ready once the transfer is received.
  - **Waiting for stock** — some unit is nowhere (item 12).
  Recomputed on every stock movement. Allocation is oldest order first, so two orders never count the same last piece.
- Tabs with counts: Ready to pack · Needs transfer · Waiting for stock · Packed today.
- **Bulk invoice print:** select many orders → one PDF; option for two invoices per A4 page.
- **Scan to pack:** open the order and scan each unit's tag (or type the SKU). Every scan ticks one unit and shows progress (3/4). A SKU not on the order, or one scanned too many times, is refused with a loud red message. **Packed stays disabled until every unit — including every outfit-set piece — has been scanned**, and the reference image has been checked (image matched).
- The order screen shows, for each item, how many are at each location.
- **Packed** deducts the units (and the default packaging materials) from the **hub's** stock, freezes the cost snapshot and sets the status to Packed. The same rules apply to single-item orders.

### 14. Order status as tabs, not a dropdown — [OPEN]
- The Orders page shows statuses as **tabs with counts**, with sub-tabs where useful: Needs confirmation · Waiting for stock · Needs transfer · Ready to pack · Packed · With courier (Handed over / In transit / Approval pending) · Delivered · Completed · Returns & exchanges · Cancelled · All.
- A **date filter** (item 16) sits at the top. Tabs for open work (Needs confirmation through With courier) always show every open order regardless of date, so nothing pending is hidden. Finished tabs (Delivered, Completed, Returns, Cancelled, All) follow the date filter, default **This Month**.

### 15. Pagination everywhere — [OPEN]
- Every list (orders, customers, products, leads, payments, expenses, transfers, members, call lists, reports…): **25 / 50 / 100 per page**, "showing X–Y of Z", server-side, and the choice remembered per user per list.

### 16. One date filter, everywhere — [OPEN]
- Options: **Today · Yesterday · Last 7 days · This Month · Last Month · All Time · Custom range**. Asia/Dhaka days.
- The same component on the dashboard (which gets a filter it doesn't have today), every report and every list with dates.

### 17. Membership — [OPEN]
- **Membership plans** (Settings): name, discount % (on products; on tailoring optional), other benefits (text), validity in months, fee (optional — recorded as income when paid), active.
- **Member card:** card number (unique; typed or scanned), customer, plan, start date, expiry, status (active / expired / cancelled), issued at which location and by whom.
- At the **POS and on online orders**, entering a member's phone number or card number shows a member badge and **applies the discount automatically**. Staff can't raise it. It does not stack with an offer — the better of the two applies.
- **Import old members** from CSV: card number, name, phone, plan, start, expiry. A phone already in the system links to that customer.
- Reports: active members, expiring in the next 30 days (feeds the follow-up team, item 18), members' share of sales.

### 18. Follow-up calling team — [OPEN]
- New role **Follow-up Executive**: sees customers and their order history (never cost), works call lists, creates orders.
- **Campaigns:** name, offer or facility, script, start/end, target segment.
- **Call lists from segments:** last purchase more than N days ago, bought from a category, lifetime value above ৳X, members / members expiring soon, bought once and never again. Excludes "do not call" customers and customers with an open order.
- **Daily assignment:** N customers per executive per day, automatically, and the same customer isn't called by two people within X days.
- **Call log** for every call: outcome — not reachable / busy / received, not interested / interested, call back on a date / sold / wrong number / do not call — plus a note and next follow-up date.
- **Sell from the call screen:** creates an order with **source: Follow-up call**, credited to the caller.
- **Incentive:** rule in Settings — fixed ৳ per order or % of order value — counted only when the order is **delivered and not returned** (same rule as targets).
- **Reports:** per executive per day — calls made, received, interested, sold, sales value, conversion %, incentive; per campaign; monthly incentive statement.

### 19. SKU pattern set by the owner — [DROPPED — do not build]

> Dropped (28 Sep 2026): after seeing how the current SKU/tag system works, the owner keeps it. Kept here only as a record of the proposal.

- Staff type an **SKU prefix** for each product: capital letters and digits, **2–6 characters**. The meaning is the owner's own, e.g. `ABSJHF` = **A**ntu **B**outique · **S**aree · **J**amdani · **H**alf silk (**F**). The system doesn't interpret it.
- The system adds **`-` + a running number** for that prefix: `ABSJHF-01`, `ABSJHF-02`, … (2 digits, 3 from 100). Every size/colour variant gets its own number. Numbers continue across products that share a prefix and are **never reused**, even after deletion.
- With a 6-character prefix and 2 digits the SKU is 9 characters and fits the 38 mm tag. Anything longer needs a 50 mm tag — the tag screen warns before printing.
- Uniqueness enforced by the database. The SKU still locks when its first tag is printed.
- The CSV import takes the prefix (SKU generated) or an existing SKU (for items that already carry tags).
- Replaces the P3.1 short format — see "Changes to existing rules" point 5.

### 20. Finding dresses inside a warehouse — [OPEN]
**The problem (owner, 28 Sep 2026):** with so many dresses, the packing team can't find where a dress is in the warehouse. Stock exists in the system, they don't find it, and the order doesn't go out.

Two causes, two fixes: nobody knows *where on the shelf* a dress is, and nobody notices when an order is quietly left unpacked.

**A. Shelf locations (C4b)**
- Each location is divided into **shelves** with short codes — e.g. `A-2-3` = rack A, shelf 2, box 3. The manager creates them in Settings; the system prints a **shelf label** with a barcode (same label printer as the price tags) to stick on each rack/box.
- **Put-away by scan:** when stock arrives (purchase, transfer received, return, exchange), the staff member scans the dress tag, then the shelf label. The system now knows that dress is on `A-2-3`. Several dresses can be scanned, then one shelf.
- **Moving:** scan dress → scan new shelf. Nothing else to type.
- **Unassigned:** stock that hasn't been put on a shelf yet shows as "Unassigned" at that location, with a count — so the manager sees what still needs putting away.
- **Count one shelf at a time:** scan a shelf, scan everything on it; the system shows what's missing or extra on that shelf. A short daily routine (a few shelves a day) keeps the whole warehouse right without closing for a full count.
- Shelf quantities are a "where is it" layer inside the location: they always add up to the location's stock and never affect accounting.
- The shelf shows everywhere someone needs to find a dress: **stock lookup**, the **order screen**, the **packing panel**.

**B. Pick list and "Not found" (C5)**
- **Pick list:** the packer selects the Ready-to-pack orders for a round and the system prints one list of everything to collect, **sorted by shelf** so they walk the warehouse once — each line with the product photo, size, colour, qty, shelf code, and which order it's for. Then they pack order by order with the scan-to-pack screen (item 13).
- Each item on the packing screen shows its shelf code and product photo, next to the customer's reference image.
- **"Not found" button:** if the dress isn't on its shelf, the packer presses Not found instead of leaving the order. The system: takes that unit off that shelf's count, looks for it on another shelf or location and updates the order's status (Ready / Needs transfer / Waiting for stock); flags the shelf for a recount; alerts the location manager. The order is never silently left behind.
- **Stuck-order alert:** orders Ready to pack for more than X hours (Settings, default 24) appear in red on the packing panel and on the manager's and owner's dashboard, with who is responsible.
- **Report:** "Not found" per day, per shelf and per product — shows where the warehouse is out of order.

---

## Information needed from the owner

| For | What |
|---|---|
| C3 | Which staff manage which location. |
| C6 | The tailoring service list with prices (or price ranges). |
| C7 | Membership plans: names, discount %, validity, fee, other benefits, card number format; the old member list as CSV. |
| C8 | Incentive rule (৳ per order or %), calls per executive per day, which segments to start with. |
| C9 | Website domain, logo, brand colours and fonts, delivery charges inside/outside Dhaka, size-chart images. |
| C12 | Meta Pixel ID and Conversions API token — entered by the owner in Settings, never in chat or code. |
