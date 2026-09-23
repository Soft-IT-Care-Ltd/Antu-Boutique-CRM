# BUILD_PROMPTS — Antu Boutique CRM

Copy-paste prompts for Claude Code, in order. One prompt at a time. After each, run its **verify** prompt and fix what it finds before moving on.

**How to use this file**
- Open Claude Code in the project folder — it picks up `CLAUDE.md` automatically.
- Paste a prompt exactly as written. Don't merge two prompts into one; each is sized to finish cleanly.
- When a prompt says "read PRD §x", let it read — don't summarise the PRD yourself.
- Commit after every prompt that passes its verify step.

---

## Phase 0 — Foundation

### P0.1 — Scaffold

```
Read CLAUDE.md and PRD.md sections 1, 3 and 7 first.

Scaffold this project: Next.js (App Router) + TypeScript + Tailwind + shadcn/ui, Prisma with PostgreSQL, NextAuth credentials, Zod. Set up:

- folder structure as described in CLAUDE.md (app/(dashboard)/<module>, app/api/<module>, lib/, components/, prisma/)
- .env.example already exists — read it and match the variable names exactly
- prisma/schema.prisma with only the AUTH & ORG tables for now: users, teams, roles, permissions, role_permissions, user_permission_overrides, audit_logs
- money as Prisma Decimal, dates stored UTC, cuid ids
- a lib/money.ts helper that formats BDT in lakh style (৳ 1,42,000)
- app shell: sidebar + topbar layout, dark/light, mobile-first, with placeholder nav items for every module in PRD §4

Do not build any business module yet. Stop when `npm run build` passes and the app renders a login page and an empty dashboard.
```

### P0.2 — Auth + RBAC engine

```
Read PRD §3 (users and roles) and the non-negotiable rules in CLAUDE.md.

Build the auth and RBAC layer:

1. NextAuth credentials login (phone or email + password, bcrypt), session JWT carrying userId, role, teamId.
2. Granular permission strings grouped into role templates for: ADMIN, MANAGER, TEAM_LEADER, SALES_EXECUTIVE, PACKING, ACCOUNTS, POS_OPERATOR. Per-user overrides on top.
3. lib/auth/permissions.ts as the ONLY place permissions are decided: `can(user, 'order.create')`, plus a route guard `requirePermission()` for API routes and a `<Can>` component for UI.
4. A shared server-side query-scope helper: SALES_EXECUTIVE sees only records they created, TEAM_LEADER only their team's, others per permission. Client filters can never widen scope.
5. A field-stripping helper used by every API response: any role without `product.cost.view` gets cost/profit/margin/purchase-price keys REMOVED from the JSON, not nulled.
6. audit_logs writer: actor, action, entity type/id, before/after JSON, IP, timestamp.
7. Forced password change on first login; lockout after 5 failed attempts for 15 minutes.

Then write a seed (prisma/seed.ts): all roles with their permissions, one admin user, sizes (Free, S, M, L, XL, XXL), a starter colour list with hex values, and a few categories.

Verify with a unit test that a SALES_EXECUTIVE API response contains no cost fields.
```

### Verify Phase 0

```
Act as a reviewer. Check, by reading the code and running it:
1. Can a SALES_EXECUTIVE session reach any route or API response that contains cost, profit, margin or purchase price? Show me the code path that prevents it.
2. Is query scoping applied in one shared place, or scattered per route?
3. Does any route skip Zod validation?
4. Is every permission decision routed through lib/auth/permissions.ts?
Report findings, then fix them.
```

---

## Phase 1 — Core sales engine

### P1.1 — Catalog with size + colour variants

```
Read PRD §4.2 and §4.3 (catalog and inventory) before starting.

Build the catalog module:
- categories (one level of nesting), sizes master, colours master (with hex swatch) — CRUD, admin only
- products: name, category, brand, description, fabric, base selling price, multiple images, tags, is_active
- product_variants: product, size, colour, auto SKU (PRD-<code>-<SIZE>-<COLOR>), stock_qty, reserved_qty, weighted_avg_cost, price_override, low_stock_threshold, is_active
- a variant matrix screen: pick sizes × colours and generate every combination at once in an editable grid
- product list with search, category filter, stock status filter, and a "low stock" quick filter
- product detail showing every variant with available = stock − reserved

Rules: cost fields are stripped for roles without product.cost.view. Stock is NOT editable directly here — it only moves through stock_movements (built in Phase 2), so for now seed stock through the seed script only.
```

### P1.2 — Customers

```
Read PRD §4.4.

Build the customer module: name, primary phone (unique), optional alternate contact number, address (division/district/thana/detail), notes, tags (VIP, wholesale, problem-customer).

There is NO payer/recipient split, NO second person, NO country field. One person per customer.

- phone-number search-as-you-type that surfaces an existing customer with their order history
- customer profile: lifetime orders, lifetime value, returns/exchanges count, average order value, last order date, risk flag (3+ refused COD deliveries)
- SE scoping applies: a sales executive sees only customers they created
```

### P1.3 — The online order form (the important one)

```
Read PRD §4.6 in full before writing anything. This screen is the heart of the system and differs from the Gift Valy CRM it descends from.

Build the order creation/edit screen with four sections exactly as the PRD describes:

1. Customer — phone search, name, optional alternate number, delivery address. ONE person; no recipient/payer split anywhere.
2. Items — product search by name/SKU, pick VARIANT (size + colour), qty, unit price (defaults from variant, editable down to the price floor), line discount. Live available-stock badge. Selling below available stock is blocked unless ADMIN/MANAGER overrides with a reason.
3. Reference images (optional, NEW):
   - upload via file picker, drag-and-drop, AND paste from clipboard (Ctrl+V of a Messenger screenshot)
   - up to 5 per order, JPEG/PNG/WebP, max 5 MB each, compressed with sharp and a thumbnail generated on upload
   - each image may optionally be tagged to ONE order line item, and may carry a caption
   - stored under /uploads/orders/<order_no>/, served through an auth-checked route, never a public static path
   - new table order_images per PRD §5.1
   - images can be added/removed AFTER order creation without the TL approval flow, but every add/replace/delete writes an audit_logs row
   - this field is always optional — an order must never be blocked for lack of an image
4. Delivery and money — channel ONLINE, courier + zone + delivery charge (auto-filled, editable), expected delivery date, advance payment (method, amount, transaction id), totals with due_amount COMPUTED server-side, internal note.

Also: order numbers as AB-YYMM-NNNN, order list with filters (status, SE, date, channel), and an order detail page showing status history.
```

### P1.4 — Order lifecycle, edit window, invoice

```
Read PRD §4.6 (lifecycle and edit window) and §6 (invariants).

Build:
1. Status lifecycle LEAD → CONFIRMED → PACKED → HANDED_TO_COURIER → IN_TRANSIT → DELIVERED → COMPLETED, plus ON_HOLD, CANCELLED, RETURNED, REFUNDED, EXCHANGE_REQUESTED. Illegal transitions rejected server-side.
2. order_status_history on every move: who, when, from, to, note.
3. Edit window: an SE may edit freely for N minutes (setting, default 30). After that, any change to items/price/discount/delivery charge creates an order_edit_request needing TL/ADMIN approval. Approval applies the change and regenerates the invoice as a NEW VERSION, keeping old versions.
4. Invoice PDF: business header, order no., customer, items with SIZE and COLOUR, totals, paid, due, footer. Bangla text must render — embed a Bangla font. Version number on the document.

Stock reservation at CONFIRMED is stubbed for now (Phase 2 adds the ledger) — write the reservation logic behind a service function so Phase 2 plugs the ledger in without touching the order code.
```

### P1.5 — Payments on the order

```
Read PRD §4.10.

Build payments against an order: amount, method (bKash/Nagad/Rocket/Bank/Cash/Card), wallet, transaction_id (GLOBALLY UNIQUE where not null), paid_at, received_by, verified flag, note. Multiple payments per order.

order.due_amount must be recomputed server-side from total − sum(payments) on every payment write, delete or order-total change. Never accept due_amount from the client. Add a database-level check or a service-layer guarantee, and a test proving a client-sent due_amount is ignored.
```

### P1.6 — Packing queue

```
Read PRD §4.8.

Build the packing module for the PACKING role:
- packing queue: all CONFIRMED orders oldest first, SLA colouring (overdue turns red)
- each queue card shows the order's REFERENCE IMAGE THUMBNAILS AT THE TOP, then items with size and colour in bold, qty, and the internal note
- clicking a thumbnail opens a full-size viewer with next/previous through that order's images
- packing checklist required before marking PACKED: items match, IMAGE MATCHED, quality checked, invoice printed
- marking PACKED deducts stock and freezes unit_cost_snapshot on every order item
- packing slip PDF: order no., customer name/phone/address, items with size + colour, qty, reference-image thumbnail, packer name, date

The PACKING role must not see customer money data beyond what is printed on the packing slip.
```

### Verify Phase 1

```
Act as a reviewer on the sales engine. Verify by reading code and testing:
1. Take an order end to end: create with 2 items and 2 pasted images → confirm → pack. Does the packer see the images and the size/colour?
2. Is due_amount ever writable from the client? Try it with a crafted request.
3. Is unit_cost_snapshot frozen at PACKED and immune to a later cost change?
4. Does any part of the order form still assume a separate recipient (second phone, country, sender message)? It must not.
5. Are order images optional everywhere — can an order be created, confirmed and packed with zero images?
6. Does an SE see another SE's orders anywhere, including in search or API responses?
Report findings, then fix them.
```

---

## Phase 2 — Stock, courier, money

### P2.1 — Purchases and the stock ledger

```
Read PRD §4.3 and invariants 2 and 3 in §6.

Build:
- suppliers, purchases, purchase_items: supplier, date, invoice no., per-variant qty and unit cost, transport/other cost allocation, amount paid/due
- weighted average cost recalculated on every purchase: new_wac = (old_qty × old_wac + in_qty × in_cost) / (old_qty + in_qty)
- stock_movements: immutable append-only ledger. Types PURCHASE_IN, SALE_OUT, RETURN_IN, EXCHANGE_OUT, EXCHANGE_IN, DAMAGE_OUT, ADJUSTMENT, POS_SALE_OUT. Each row: variant, signed qty, reference type/id, unit cost snapshot, actor, timestamp, note.
- EVERY stock change and its ledger row happen in ONE Prisma transaction. Plug this into the Phase 1 reservation/deduction service functions.
- manual adjustment with a required reason, ADMIN/MANAGER only
- damage/write-off: DAMAGE_OUT plus an expense line at cost
- stock report per variant (on hand, reserved, available, value at cost) and low-stock alerts per variant with a product-level roll-up

Add a test that proves stock and ledger can never diverge: sum(stock_movements.qty) per variant must equal stock_qty.
```

### P2.2 — Courier module + Steadfast

```
Read PRD §4.9.

Build:
- courier_companies with per-zone charges (inside city / sub-city / outside city), COD charge %, return charge
- shipments per order: courier, consignment/tracking id, booked_at, status, delivery charge, COD amount, COD received at
- Steadfast integration following the same pattern as the Gift Valy CRM's STEADFAST_INTEGRATION.md: create consignment from the order screen, webhook endpoint for status updates, and a polling reconciliation cron every 15 minutes as a safety net (protected by CRON_SECRET)
- courier API credentials stored ENCRYPTED using COURIER_ENCRYPTION_KEY
- COD reconciliation: enter or CSV-import a courier statement, match against orders, show collected / not received / short, flag discrepancies for ACCOUNTS
- courier return flow: RETURNED → condition check by PACKING → restock (RETURN_IN) or write-off (DAMAGE_OUT) → courier return charge posted as an expense
```

### P2.3 — Wallets, verification, expenses

```
Read PRD §4.10 and §4.12.

Build:
- wallets (bKash personal/merchant, Nagad, Rocket, bank, showroom cash) with running balances, manual in/out entries and a statement per date range
- payment verification queue for ACCOUNTS; unverified payments listed until verified
- refunds as negative payments with reason and approval
- expenses: date, category (ad cost, purchase, courier, salary, rent, utility, packaging, transport, exchange/return cost, misc), fixed vs variable, amount, wallet paid from, note, attachment
- daily_ad_spend with an allocation setting (equal split across the day's confirmed orders, or by order value)
- collection report and expense report

Expenses, wallets and anything profit-related are ADMIN/MANAGER/ACCOUNTS only per the permission matrix.
```

### Verify Phase 2

```
Reviewer pass on stock and money. Verify by reading code and testing:
1. Prove sum(stock_movements) per variant equals stock_qty after a purchase, a sale, a cancel, a courier return and a partial delivery.
2. Can any code path change stock without writing a ledger row? Show me.
3. Are courier credentials encrypted at rest and never returned in an API response?
4. Is transaction_id uniqueness enforced at the database level?
5. Does the Steadfast webhook reject a wrong or missing token, and is the cron endpoint protected by CRON_SECRET?
6. With STEADFAST_LIVE_API unset, can any code path make a real booking or status call?
7. Full money round trip: an order with an advance and COD → packed → sent (mocked) → delivered → payout synced → COMPLETED. Check that the due is 0, the wallet moved by exactly the net payout, the delivery charge and COD fee posted as expenses once, and nothing is counted twice under the P&L rule (PRD §4.12).
8. Replay the same payout: no duplicate payments or expenses. A mismatched payout moves no money.
9. Every wallet's balance equals its statement's closing figure, and no stored balance column exists that could drift.
10. Log in as SALES_EXECUTIVE, TEAM_LEADER and PACKING: every courier, wallet, expense, payout and report route returns 403 or 404, and no money or cost field appears anywhere.
Report findings, then fix them.

Automated: lib/courier/__tests__/phase2-verify.integration.test.ts, lib/courier/__tests__/live-api-switch.test.ts, lib/auth/__tests__/money-routes.integration.test.ts.
```

---

## Phase 3 — POS, returns, exchanges, outfit sets

> Rewritten 24 Sep 2026 after Phase 2, using the lessons in `docs/reference/gift-valy/CORRECTIONS.md` (Orders 6n, Products 1–5, Round 2 items 2.2, 2.3, 2.8). Run in order: P3.0 → P3.1 → P3.2 → P3.3 → Verify.

### P3.0 — iPhone / iPad safety net (small, do first)

```
Read docs/reference/gift-valy/CORRECTIONS.md ROUND 2 item 2.8. Gift Valy's login page went completely blank on every iPhone because a modern JS feature crashed older Safari before hydration. Antu's showroom POS will likely run on an iPad and sales staff use iPhones, so prevent this now:
- add a browserslist target that covers iOS Safari 15+ and make sure the build honours it
- scan source and built bundles for syntax older Safari can't run (regex lookbehind, structuredClone, Array.at, crypto.randomUUID without fallback, etc.) and fix or polyfill
- add a global client error boundary that shows a visible "Something went wrong — Reload" message instead of a silent white page
Commit separately.
```

### P3.1 — POS / walk-in

```
Read PRD §4.7, and CORRECTIONS.md ROUND 2 item 2.3 (type-ahead search).

Build the POS screen for showroom sales:
- fast type-ahead search by product name, SKU or barcode, showing size, colour and available stock per variant; cart, qty, discount, payment (Cash/bKash/Nagad/Card), complete sale
- channel WALK_IN, no courier, no delivery address; customer optional (anonymous, or a phone number links them for repeat tracking)
- stock deducts IMMEDIATELY on sale through the ledger (POS_SALE_OUT), status goes straight to COMPLETED, unit_cost_snapshot frozen at sale
- print or skip the invoice
- cash drawer per day: opening balance, cash sales, cash out, closing balance, and an end-of-day count with the difference shown — ties into the showroom cash wallet from P2.3
- keyboard-first on desktop, large touch targets on a tablet; test at iPad width
- POS_OPERATOR sees no cost or profit anywhere, same as a sales executive
- walk-in sales use the same payments, wallets and P&L tables as online orders, and never receive allocated ad cost (per the P2.3 decision)
Every existing report and list gains a channel filter (Online / Walk-in).
```

### P3.2 — Returns and exchanges (online and at the counter)

```
Read PRD §4.11, CORRECTIONS.md Orders item 6n, and the condition-check decision in PRD §4.9 (lib/returns/condition-check.ts). Every return and exchange must go through that one service — do not write a second one.

Rules from Gift Valy 6n that apply here:
- a return or exchange is PENDING until the item is physically back in our hands; no stock moves while pending
- on receipt, Packing inspects every unit: OK → back to sellable stock, Damaged → "Damage / write-off" at the frozen cost
- fully audit-logged: who received, what was marked damaged

Return / refund: reason required, TL/ADMIN approval, condition check on receipt, refund as an approved negative payment (P2.3 rules), order → RETURNED/REFUNDED.

Exchange (size/colour change) — two ways it happens, both must work:
A. ONLINE (customer sends it back by courier): original order → EXCHANGE_REQUESTED; a NEW linked order carries exchanged_from_order_id and ships the replacement variant through the normal packing/courier flow (EXCHANGE_OUT). The returned item is restocked only after the condition check (EXCHANGE_IN).
B. AT THE COUNTER (customer walks into the showroom with the item): no courier. Staff inspect on the spot, swap the variant, settle any price difference, and both stock movements happen immediately in one transaction. Very common for a boutique — make it a fast flow from the POS screen or the order page.

For both:
- the price difference is a normal payment line: customer pays extra, or an approved refund/credit
- courier_charge_bearer = CUSTOMER or COMPANY (online only); company-borne cost posts once as an expense under the exchange/return cost category
- exchange_reason required: wrong size / wrong colour / not as expected / defective / other
- both orders show the link and the reason on screen
- exchange report by reason, by product and variant, by SE, with company-borne cost totalled — a product exchanged again and again is a sizing or photo problem

Add the new flows to the Phase 2 ledger test: stock must still equal the sum of ledger rows after an online exchange, a counter exchange and a return with one damaged unit.
```

### P3.3 — Outfit sets

```
Read PRD §4.2 (outfit sets), then CORRECTIONS.md "Products & Packages" items 1, 2, 4 and 5, and ROUND 2 item 2.2.

IMPORTANT design change from the PRD: an outfit set is built from PRODUCTS, not fixed variants. A set like "Kurti + Dupatta + Plazo" must not need a separate set for every size and colour. At order entry (online and POS), when a set is added, the SE picks the size and colour for each component — like Gift Valy's "choice slots". The chosen variant is stored on the order item, shown on the packing queue and order detail, and its stock is what gets reserved and deducted. Update PRD §4.2 to match.

Build:
- set = list of component products with quantity (quantity drives cost, stock deduction and availability everywhere)
- set price is set independently; set cost = sum of the CHOSEN variants' weighted average cost × qty, frozen at packing like any line
- availability: per chosen size/colour combination = min over components of floor(available ÷ qty); the set list shows whether at least one full combination is available
- packing queue, packing slip and pack dialog show the FULL explosion — every component with its chosen size and colour — never just the set name (Gift Valy 2.2 bug)
- the invoice shows the set name with an indented list of what's included (names and qty only, no costs)
- a set can be sold online and at the POS; searchable by name like any product
- returns and exchanges of a set can be for one component only (customer keeps the kurti, exchanges the plazo size) — route that through the P3.2 flows at component level
- outfit-set availability report naming the limiting component

Optional — keep only if Antu uses branded bags, boxes or tissue you want to track:
- packaging materials as "component only" products (stocked, costed, never sellable, hidden from order search), attachable to products and sets so packing deducts them and their cost counts (Gift Valy Products 1–2)
```

### Verify Phase 3

```
Reviewer pass on Phase 3. Verify by reading code and testing:
1. A walk-in sale: stock, payment, showroom cash wallet and the day's cash drawer all move correctly, no courier or shipment record is created, and no ad cost is allocated.
2. An online size exchange end to end: original linked, replacement shipped, returned item not restocked until the condition check, price difference settled, company-borne courier cost posted once.
3. A counter exchange: both stock movements in one transaction, no courier record, price difference settled on the spot.
4. An outfit set sold with chosen sizes/colours: the right variants are reserved and deducted, packing shows the full explosion, the invoice lists the components, and availability drops when one component's chosen variant runs low.
5. Exchanging one component of a set works without touching the other components.
6. Stock still equals the sum of ledger rows after all of the above.
7. POS_OPERATOR and SALES_EXECUTIVE see no cost, profit or margin on any POS, exchange or set screen or API response.
8. Every report respects the channel filter.
9. The app loads on an iPhone-width and iPad-width viewport with no blank screen, and the error boundary shows if a client error is forced.
Report findings, then fix them.
```

---

## Phase 4 — Leads, targets, HR, dashboards, reports

### P4.1 — Leads and follow-ups

```
Read PRD §4.5. Build leads with source (Facebook Ad, Messenger, WhatsApp, Instagram, Referral, Repeat, Showroom Walk-in, Other) and optional campaign, status funnel NEW → CONTACTED → FOLLOW_UP → NEGOTIATING → CONVERTED → LOST with required lost reason, follow-up reminders with a "due today" list on the SE dashboard and overdue highlighting, bulk daily-count quick entry, and lead → order conversion that pre-fills the order form and sets order.lead_id. Conversion-rate reporting per SE, source and campaign.
```

### P4.2 — Targets, leaderboard, attendance

```
Read PRD §4.13 and §4.14. Build monthly targets per SE and per team (order count and/or value) with a live progress gauge, a reward-rules table evaluated at month end, and a leaderboard that shows delivered-vs-returned quality beside the value so volume alone can't win. Then attendance: check-in/check-out, late/absent/half-day/leave flags from office-hour settings, leave requests with TL/ADMIN approval, and a monthly attendance report.
```

### P4.3 — Dashboards

```
Read PRD §4.16. Build the role-based dashboards exactly as described: OWNER/ADMIN (today row, MTD row, operations funnel, team row, 30-day charts, alerts), SALES_EXECUTIVE (my leads, follow-ups due today, my orders by status, target gauge — no cost, no profit, no other SE's data), TEAM_LEADER (team versions plus pending approvals), PACKING (queue counts, packed today, low stock), ACCOUNTS (unverified payments, today's collection, COD pending, wallet balances). Use Recharts. Every number must be clickable through to the list it summarises.
```

### P4.4 — Reports and P&L

```
Read PRD §4.15. Build reports R1–R14 with date range plus the filters listed per report, CSV and PDF export, and role scoping (an SE's report shows only their own data; cost columns absent without product.cost.view). Then the P&L: revenue, COGS from unit_cost_snapshot, gross profit and margin, operating expenses by category, net profit and margin, month-on-month comparison — ADMIN/MANAGER only. Finally the audit-log viewer, filterable by user, entity and date, ADMIN only.
```

### Verify Phase 4

```
Reviewer pass on reporting and access:
1. Log in as each role and list every screen and API route reachable. Does anything leak cost, profit or another user's data?
2. Do report totals reconcile with the underlying tables (sales report total = sum of order totals for the same filter)?
3. Does the P&L's COGS use unit_cost_snapshot rather than current cost?
4. Are exports scoped the same way as the on-screen report?
Report findings, then fix them.
```

---

## Phase 5 — Polish and go-live

### P5.1 — System hardening

```
Build the remaining system-wide behaviour from PRD §4.18: soft delete with a 30-day trash and restore for orders/customers/products, a nightly purge cron, a nightly pg_dump backup with 14-day retention and a backup-status indicator in Settings that alerts if the last backup is older than 48 hours, and the low-stock daily alert. Confirm Bangla renders correctly in every PDF. Make the app installable as a PWA with the SE, PACKING and POS screens fully usable on a phone.
```

### P5.2 — Settings and go-live data

```
Build the Settings module from PRD §4.17 (business profile, size/colour/category masters, courier companies and zones, payment methods and wallets, edit-window minutes, low-stock default, office hours, ad-cost allocation method, targets and reward rules, roles and permissions, users, Steadfast credentials and webhook URL, backup status). Then create an import path for real opening data: products with variants and opening stock, customers, wallet opening balances.
```

### P5.3 — Deploy

```
Prepare production deployment for a VPS: Node 20, PM2 process config, Nginx reverse proxy config, Certbot SSL, crontab entries for the Steadfast sync (every 15 min) and trash cleanup (daily) using CRON_SECRET, a documented backup script, and a DEPLOYMENT.md with the exact commands. Include the post-deploy checklist: DNS pointed, SSL issued, Steadfast webhook URL updated on the courier's panel, first login works, a test order end to end, cron logs filling.
```

### Final verification

```
Final pre-launch review. Go through PRD §6 (the ten invariants) one by one and prove each holds, with the code path or a test for each. Then run the full role matrix: for every role, confirm what they can see and do matches PRD §3. List anything that fails. Do not mark this done until all ten invariants are proven.
```

---

## A few prompts worth keeping for later

**When something feels wrong**
```
Read PRD §<section>. Compare what's built against what's written there and list every difference, with file and line. Don't fix anything yet — show me the list first.
```

**Before any schema change**
```
I want to change <X>. Before touching anything: what breaks? List every table, API route, report and screen that depends on the current shape, and what the migration would need to do to existing data.
```

**Adding a feature later**
```
Read CLAUDE.md and the relevant PRD section. I want to add <feature>. Propose where it fits in the existing modules and data model, what it would break, and what the smallest version worth building is. Wait for my go-ahead before writing code.
```
