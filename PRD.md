# Antu Boutique CRM — Product Requirements Document (PRD)

**Version:** 1.0
**Date:** 21 September 2026
**Owner:** M.H. Neshad — Soft IT Care Ltd
**Repository:** `https://github.com/Soft-IT-Care-Ltd/Antu-Boutique-CRM.git`
**Lineage:** Feature set carried over from Gift Valy CRM (`Soft-IT-Care-Ltd/Gift-Valy-CRM`), adapted for a boutique/fashion business. New database, new repo, nothing shared with Gift Valy at runtime.

---

## 1. What this system is

An internal CRM/ERP for **Antu Boutique**, a Bangladeshi fashion boutique selling clothing **online** (Messenger, Facebook, WhatsApp, Instagram) and **from a physical showroom**.

It must run the whole business in one place: lead → order → stock → packing → courier → payment → profit, plus staff targets, attendance, and the owner's daily numbers.

### 1.1 Primary goals

1. **No order is lost or mis-packed.** Every order carries everything the packer needs, including the customer's own reference photo.
2. **Stock is always true**, down to size and colour.
3. **Money is always reconciled** — what was sold, what was collected, what is still due, what it cost, what was earned.
4. **Owner sees the business in 10 seconds** on one dashboard.
5. **A sales executive can never see cost or profit**, and can never see another executive's customers.

### 1.2 Explicitly out of scope (v1)

- Customer-facing storefront / e-commerce website (this is an internal system only)
- Accounting integration (Tally/QuickBooks), payroll processing
- Multi-branch/multi-warehouse (single showroom + single stock location for v1, but schema must not block it)
- Automated marketing / ad-platform API integration

---

## 2. How Antu Boutique works (business model)

| Aspect | Reality |
|---|---|
| Who buys | The customer buys **for themself**. The buyer is the recipient. |
| Delivery | Courier to the customer's own address, or handed over at the showroom. |
| How orders arrive | Mostly Messenger/WhatsApp chat. Customers frequently **send a photo** of the item instead of naming it. |
| What is sold | Individual garments with **size and colour** variants, plus occasional **outfit sets** (kurti + dupatta + plazo as one sellable item). |
| Payment | Full advance, partial advance + COD, or full COD. bKash / Nagad / Rocket / Bank / Cash. |
| Returns | Return/refund, and very commonly **exchange for a different size or colour**. |

> **This is the key difference from Gift Valy CRM.** Gift Valy assumed an expatriate payer abroad and a recipient in Bangladesh (two people, two phone numbers, country fields, gift occasions). Antu Boutique has **one person per order**. All payer/recipient splitting is removed.

---

## 3. Users and roles

| Role | Who | Core job in the system |
|---|---|---|
| **Admin / Owner** | M.H. Neshad | Everything. Only role that sees cost, profit, P&L, audit log, settings. |
| **Manager** | Business manager | Everything except system settings and user deletion. Sees cost and profit. |
| **Team Leader (TL)** | Sales team lead | Own team's leads/orders/targets, approves order edits and returns/exchanges. No P&L. |
| **Sales Executive (SE)** | Sales staff | Own leads, own orders, own customers only. **Never sees cost, profit, margin, or purchase price — anywhere.** |
| **Packing / Operations** | Packing staff | Packing queue, order items, reference images, stock on hand, courier hand-over. No prices beyond what is on the packing slip, no customer money data. |
| **Accounts** | Accounts staff | Payments, verification, collection, expenses, wallets, courier COD reconciliation. No lead/sales-target management. |
| **Showroom / POS operator** | Showroom staff | POS quick sale, walk-in customers, showroom stock. |

### 3.1 RBAC rules (non-negotiable)

- Permissions are **granular permission strings** (e.g. `order.create`, `order.edit_after_window`, `report.pl.view`, `product.cost.view`), grouped into role templates, with **per-user overrides**.
- **Cost, profit, margin and purchase price are stripped at the API layer** for roles without `product.cost.view` — not merely hidden in the UI. A raw API response to an SE must not contain the field at all.
- **Data scoping:** an SE's list queries are automatically filtered to `created_by = self`; a TL's to `team_id = own team`. Scoping is enforced server-side in a shared query helper, never by trusting a client-sent filter.
- Every sensitive mutation (order edit, price change, payment edit/delete, stock adjustment, user/permission change, image delete, exchange approval) writes an **audit log** row: actor, action, entity, before/after JSON, IP, timestamp.

---

## 4. Modules

### 4.1 Authentication & organisation

- NextAuth credentials login (email/phone + password), bcrypt hashing, session JWT.
- Users: name, phone, email, role, team, join date, active flag, avatar.
- Teams: name, team leader, members.
- Forced password change on first login; admin can reset.
- Account lockout after 5 failed attempts for 15 minutes.

### 4.2 Catalog — categories, products, variants

**Category:** name, parent (one level of nesting), active flag, sort order.

**Product** (the garment): name, category, brand/house, description, fabric, base selling price, product images (multiple), `is_active`, tags.

**Product Variant** (what actually has stock and price):

| Field | Note |
|---|---|
| `product_id` | parent garment |
| `size` | from the Size master list (Free, S, M, L, XL, XXL, or numeric) |
| `color` | from the Colour master list, with a hex swatch |
| `sku` | auto-generated `PRD-<code>-<SIZE>-<COLOR>`, unique, editable once |
| `stock_qty`, `reserved_qty` | on-hand and reserved (available = stock − reserved) |
| `weighted_avg_cost` | recalculated on every purchase |
| `price_override` | optional; falls back to product base price |
| `low_stock_threshold` | per variant, default from settings |
| `is_active` | |

- **Variant matrix screen:** pick sizes × colours, generate all combinations at once, set stock and cost in a grid.
- Size and Colour are **master lists in Settings** — so "Maroon" is one value, not five spellings.
- Low-stock alerts fire **per variant**, plus a product-level roll-up ("Kurti #12: only XL left").

**Outfit Set (BOM / package):** a sellable item composed of multiple variants (kurti L/Maroon + dupatta + plazo L). Cost = sum of component `weighted_avg_cost`. **Available-to-sell = floor of (component available ÷ component qty)** across components. Selling an outfit set deducts every component.

### 4.3 Inventory

- **Purchase entry:** supplier, date, invoice no., per-variant qty and unit cost, transport/other cost allocation, payment made/due.
- **Weighted average cost** recalculated on every purchase: `new_wac = (old_qty × old_wac + in_qty × in_cost) ÷ (old_qty + in_qty)`.
- **`stock_movements` ledger is immutable and append-only.** Types: `PURCHASE_IN`, `SALE_OUT`, `RETURN_IN`, `EXCHANGE_OUT`, `EXCHANGE_IN`, `DAMAGE_OUT`, `ADJUSTMENT`, `POS_SALE_OUT`. Every row: variant, qty (+/−), reference type/id, unit cost snapshot, actor, timestamp, note.
- **Stock and its ledger row are written in one database transaction.** Never one without the other.
- Manual stock adjustment requires a reason and is Admin/Manager only.
- Damage/write-off posts `DAMAGE_OUT` and an expense line at cost.

### 4.4 Customers

- One person: name, **primary phone (unique)**, optional alternate contact number, address (division / district / thana / detail), notes, tags (VIP, wholesale, problem-customer).
- **No payer/recipient split, no second person, no country field, no sender message.**
- Auto-dedupe on phone number at order entry: typing a known number pulls up the existing customer with their order history.
- Customer profile shows lifetime orders, lifetime value, returns/exchanges count, average order value, last order date, and a **risk flag** (e.g. 3+ refused COD deliveries).

### 4.5 Leads & follow-ups

- Source: Facebook Ad, Messenger, WhatsApp, Instagram, Referral, Repeat Customer, Showroom Walk-in, Other. Optional campaign name.
- Status funnel: `NEW → CONTACTED → FOLLOW_UP → NEGOTIATING → CONVERTED → LOST`, with required lost reason (price, size unavailable, no response, bought elsewhere, other).
- Follow-up reminder with date/time; "my follow-ups due today" list on the SE dashboard; overdue follow-ups highlighted.
- Bulk daily-count quick entry (for days when leads are counted, not individually recorded).
- Converting a lead pre-fills the order form and links `order.lead_id`.
- Conversion-rate reporting per SE, source, and campaign.

### 4.6 Orders — the online order form

**This is the screen that differs most from Gift Valy. Build it exactly as described.**

**Section 1 — Customer**
- Phone number (search-as-you-type against existing customers), name, alternate contact number (optional), full delivery address.
- One person only. No "who is paying" / "who is receiving" split anywhere.

**Section 2 — Items**
- Product search by name or SKU → pick **variant (size + colour)** → qty → unit price (defaults to variant/base price, editable within the price floor) → line discount.
- Outfit sets appear in the same search and expand into their components on the packing slip.
- Live available-stock badge per variant; selling below available stock is blocked unless Admin/Manager overrides with a reason.

**Section 3 — Reference images (NEW, optional)**
- Because customers send a product photo on Messenger instead of naming the item, the SE attaches those photos to the order.
- **Upload from file picker AND paste from clipboard (Ctrl+V of a Messenger screenshot).** Drag-and-drop too.
- Up to **5 images per order**, JPEG/PNG/WebP, ≤5 MB each, auto-compressed on upload with a thumbnail generated.
- Each image may optionally be **tagged to one order line item**, so a 3-item order shows which photo belongs to which line.
- Optional caption per image (e.g. "customer wants this print, dark shade").
- Stored under the app's local `/uploads` folder, same pattern as Gift Valy (so backup and server-migration steps already cover it).
- **Images may be added after order creation** (customer sends the photo later) without the TL edit-approval flow — an image is not a money field — but every add/replace/delete is written to the audit log with user and timestamp.
- Permissions: anyone who can view the order can view its images. Upload/replace/delete limited to the order's SE, their TL, and Admin.

**Section 4 — Delivery & money**
- Channel: `ONLINE` (default here) — courier company, delivery zone, delivery charge (auto-filled from the courier's zone table, editable), expected delivery date.
- Advance payment: method, amount, transaction ID.
- Order total: items subtotal − discount + delivery charge = total; advance paid; due amount (auto-computed, never typed).
- Internal note field (visible to staff, never printed for the customer).

**Order lifecycle**

`LEAD → CONFIRMED → PACKED → HANDED_TO_COURIER → IN_TRANSIT → DELIVERED → COMPLETED`
plus `ON_HOLD`, `CANCELLED`, `RETURNED`, `REFUNDED`, `EXCHANGE_REQUESTED`.

- Stock is **reserved at `CONFIRMED`** and **deducted at `PACKED`** (with `unit_cost_snapshot` frozen at that moment).
- Cancelling before `PACKED` releases the reservation; cancelling after `PACKED` restores stock via a ledger row.
- **Edit window:** an SE may freely edit an order for X minutes after creation (default 30, set in Settings). After that, any edit that changes items, price, discount or delivery charge needs **TL/Admin approval** — the edit is queued as a request, and an approved edit regenerates the invoice as a new version.
- Full status history / audit trail per order: who moved it, when, from what to what.

### 4.7 POS — walk-in / showroom sale

- Separate fast screen: product/SKU search or barcode field → cart → quantity → discount → payment (Cash/bKash/Nagad/Card) → done.
- Channel is `WALK_IN`. **No courier, no delivery address required.** Customer record optional (walk-in can be anonymous, or a phone number captures them for repeat tracking).
- Stock deducts **immediately** on sale (no `CONFIRMED` reservation step); status goes straight to `COMPLETED`.
- Prints/skips an invoice; posts to the same payments, wallets and P&L tables as online orders.
- Daily showroom cash drawer: opening balance, cash sales, cash out, closing balance, with a cash-reconciliation screen at day end.

### 4.8 Packing & operations

- **Packing queue**: all `CONFIRMED` orders, oldest first, with SLA colouring (over-due orders turn red).
- Order card in the queue shows **reference-image thumbnails at the top**, item list with **size and colour in bold**, quantity, and the internal note.
- Click a thumbnail → full-size viewer, next/previous through the order's images.
- **Packing checklist** before marking `PACKED`:
  - [ ] Items match the order lines
  - [ ] **Image matched** — packer confirms the physical item against the customer's photo
  - [ ] Quality checked (no defect, no stain)
  - [ ] Invoice printed and inserted
- Packing slip (print) carries: order no., customer name/phone/address, items with size + colour, quantity, **reference-image thumbnail**, packer name, date.
- Marking `PACKED` deducts stock and freezes cost snapshots.

### 4.9 Courier & delivery

- Courier company table: name, contact, **per-zone delivery charge** (inside city / sub-city / outside city), COD charge %, return charge.
- Shipment record per order: courier, consignment/tracking ID, booked at, status, delivery charge, COD amount, COD received at.
- **Steadfast integration** (same pattern as Gift Valy's `STEADFAST_INTEGRATION.md` — reusable almost as-is): create consignment from the order screen, webhook for status updates, plus a polling reconciliation cron every 15 minutes as a safety net.
- Courier API credentials stored **encrypted** with `COURIER_ENCRYPTION_KEY`.
- **COD reconciliation:** courier statement (manual entry or CSV import) matched against orders; shows collected / not yet received / short; discrepancies flagged for Accounts.
- Return flow from courier: `RETURNED` → condition check by Packing → restock (`RETURN_IN`) or write-off (`DAMAGE_OUT`) → courier return charge posted as an expense.

### 4.10 Payments & wallets

- **Multiple payments per order**: advance, partial, COD collection, post-delivery settlement.
- Each payment: amount, method (bKash / Nagad / Rocket / Bank / Cash / Card), wallet, transaction ID, paid at, received by, verified flag, note.
- **Transaction ID is globally unique** across the system (prevents the same bKash TrxID being used twice).
- Accounts verifies payments; unverified payments show in an "awaiting verification" queue.
- **`order.due_amount` is recomputed on every payment write, never typed by a human.**
- Wallets (bKash personal, bKash merchant, Nagad, bank account, showroom cash) with running balances, manual in/out entries, and a wallet statement per date range.
- Refunds recorded as negative payments with a reason and approval.

### 4.11 Returns & exchanges

**Return/refund**
- Reason required; TL/Admin approval; condition check by Packing; restock or write-off; refund payment row; order → `RETURNED` / `REFUNDED`.

**Exchange (size/colour change) — new module, not in Gift Valy**
- Creates a **linked order**: the original goes to `EXCHANGE_REQUESTED`; the new order carries `exchanged_from_order_id`; both screens show the link and the reason.
- Returned variant goes back to stock **only after a Packing condition check**: Good → `EXCHANGE_IN` restock; Damaged → `DAMAGE_OUT` write-off.
- New variant is issued through the normal packing/courier flow (`EXCHANGE_OUT`).
- **Price difference** settled as a normal payment line: customer pays extra, or gets a refund/credit.
- **Courier charge bearer** is an explicit field: `CUSTOMER` or `COMPANY`. Company-borne amounts post to expenses, so exchange cost lands in P&L.
- **Exchange reason** required: wrong size / wrong colour / not as expected / defective / other → feeds a monthly exchange-reason report (early warning for sizing charts or product photos).
- Exchange rate per product and per SE is reported — a garment exchanged repeatedly is a product problem, not a customer problem.

### 4.12 Expenses & accounting

- Daily expense entry: date, category (ad cost, product purchase, courier, salary, rent, utility, packaging, transport, exchange/return cost, misc), **fixed vs variable**, amount, wallet paid from, note, attachment.
- **Per-order profit** = selling total − product cost (from `unit_cost_snapshot`) − courier cost − packaging cost − allocated ad cost.
- Ad-cost allocation: daily ad spend spread across that day's confirmed orders (setting: per-order equal split or by order value).
- **Monthly P&L**: revenue, COGS, gross profit, gross margin %, operating expenses by category, net profit, net margin %, month-on-month comparison.
- Wallet running balances and a cash-position view.
- **Admin/Manager only.** Not visible to SE, TL, Packing.

### 4.13 Targets, rewards, leaderboard

- Monthly target per SE and per team: order count and/or order value.
- Live progress gauge on the SE dashboard ("Tk 1,42,000 of Tk 2,00,000 — 71%, 9 days left").
- Reward rules table: threshold → reward (amount or note), auto-evaluated at month end.
- Leaderboard: this month's top SEs by value and by converted orders, with delivered-vs-returned quality shown alongside (so quantity alone can't win).

### 4.14 Attendance & leave

- Check-in / check-out with time; late / absent / half-day / leave flags driven by office-hour settings.
- Leave request → TL/Admin approval → reflected in the attendance sheet.
- Monthly attendance report per staff member.

### 4.15 Reports

All reports: date-range filter, plus filters for SE / team / status / channel / category as relevant; **CSV and PDF export**; role-scoped (an SE's report shows only their own data; cost columns absent for roles without `product.cost.view`).

| # | Report | Key content |
|---|---|---|
| R1 | Sales | Orders and value by day/week/month, by channel (Online vs Walk-in), by SE, by category |
| R2 | Leads | Leads by source/campaign, conversion rate, lost reasons |
| R3 | Team performance | Per SE: leads, orders, value, delivered, returned, exchanged, conversion %, target % |
| R4 | Stock | Per variant: on hand, reserved, available, value at cost, low-stock list |
| R5 | Outfit-set availability | Available-to-sell per set with the limiting component named |
| R6 | Courier | Orders per courier, delivered vs returned %, average delivery days, courier charges |
| R7 | Collection | Collected vs due by date, COD pending, ageing buckets |
| R8 | Expense | By category, fixed vs variable, month-on-month |
| R9 | P&L | Revenue, COGS, gross/net margin, per month |
| R10 | Attendance | Present/late/absent/leave per staff, monthly |
| R11 | Cancelled & returned | Reasons, count, value lost, by SE and by product |
| R12 | Customer | Top customers by value, repeat rate, risk-flagged customers |
| R13 | **Exchange** | Exchanges by reason, by product/variant, by SE; cost borne by company |
| R14 | **Channel** | Online vs Walk-in: orders, value, margin, average order value |

### 4.16 Dashboards

**Owner/Admin**
- Today: orders, value, collected, due, expenses, profit
- MTD: same row, plus target progress
- Operations funnel: leads → confirmed → packed → in transit → delivered (live counts)
- Team row: leaderboard top 5, attendance present-count
- 30-day charts: sales trend, channel split, profit trend, return/exchange rate
- Alerts: low stock, overdue follow-ups, unverified payments, COD not received > X days, orders stuck in one status

**SE:** my leads, my follow-ups due today, my orders by status, my target gauge, my this-month value. **No cost, no profit, no other SE's data.**

**TL:** team versions of the above, plus pending approval requests (order edits, returns, exchanges).

**Packing:** packing queue count, packed today, ready-to-hand-over, low-stock alerts.

**Accounts:** unverified payments, today's collection, COD pending, wallet balances, today's expenses.

### 4.17 Settings (Admin only)

Business profile (name, logo, address, phone, invoice footer) · Size master · Colour master · Category master · Courier companies and zone charges · Payment methods and wallets · Order edit-window minutes · Low-stock default threshold · Office hours and late rule · Ad-cost allocation method · Target and reward rules · Roles and permissions · Users · Steadfast API credentials and webhook URL · Backup status.

### 4.18 System-wide behaviour

- **Audit log** on every sensitive mutation, with a viewer (Admin only), filterable by user/entity/date.
- **Soft delete + Trash**: deleted orders/customers/products go to trash, restorable for 30 days, then purged by a nightly cron.
- **Nightly `pg_dump` backup** — non-negotiable. Backup status visible in Settings; alert if the last backup is older than 48 hours.
- **Bangla support**: Bangla text renders correctly everywhere including PDFs (embedded Bangla font in the invoice/packing slip).
- **Mobile-first**: SE, Packing and POS screens must be fully usable on a phone; installable as a PWA.

---

## 5. Data model (table groups)

**AUTH & ORG** — `users`, `teams`, `roles`, `permissions`, `role_permissions`, `user_permission_overrides`, `sessions`, `audit_logs`

**LEADS** — `leads`, `lead_followups`, `lead_daily_counts`

**CATALOG & STOCK** — `categories`, `products`, `product_images`, `product_variants`, `sizes`, `colors`, `outfit_sets`, `outfit_set_items`, `suppliers`, `purchases`, `purchase_items`, `stock_movements`

**CUSTOMERS & ORDERS** — `customers`, `orders`, `order_items`, **`order_images`**, `order_status_history`, `order_edit_requests`, `invoices`

**RETURNS & EXCHANGES** — `returns`, `exchanges` (`original_order_id`, `new_order_id`, `reason`, `courier_charge_bearer`, `price_difference`, `approved_by`)

**COURIER** — `courier_companies`, `courier_zones`, `shipments`, `courier_statements`, `courier_statement_lines`

**MONEY** — `payments`, `wallets`, `wallet_transactions`, `expenses`, `expense_categories`, `daily_ad_spend`

**HR & PERFORMANCE** — `targets`, `reward_rules`, `attendance`, `leave_requests`

**SETTINGS** — `settings`, `notifications`

### 5.1 `order_images` (the new table)

| Column | Type | Note |
|---|---|---|
| `id` | uuid/cuid | |
| `order_id` | fk → orders | cascade with the order's trash/restore |
| `order_item_id` | fk → order_items, nullable | optional tag to one line |
| `file_path` | text | under `/uploads/orders/<order_no>/` |
| `thumb_path` | text | generated on upload |
| `caption` | text, nullable | |
| `mime_type`, `size_bytes` | | validated: image/jpeg, image/png, image/webp, ≤5 MB |
| `uploaded_by` | fk → users | |
| `uploaded_at` | timestamp | |
| `deleted_at` | timestamp, nullable | soft delete, audit-logged |

---

## 6. Business rules — the invariants

These are the rules a reviewer should check on every pull request:

1. `order.due_amount` is **always** recomputed from `total − sum(payments)`. Never accepted from the client.
2. A stock change and its `stock_movements` row are written **in the same transaction**. No exceptions.
3. `unit_cost_snapshot` is frozen on the order item **at `PACKED`** and never changes afterwards — historical profit must not move when today's purchase price changes.
4. `payments.transaction_id` is **globally unique** (where not null).
5. Cost, profit, margin and purchase price are **stripped server-side** for roles without `product.cost.view`.
6. List queries are **scoped server-side** by role (SE → own, TL → team). The client cannot widen the scope.
7. Selling below available stock is blocked, except by an Admin/Manager override that records a reason.
8. An approved order edit **regenerates the invoice as a new version**; old versions are retained.
9. Every sensitive mutation writes an `audit_logs` row.
10. Reference images are never a reason to block or delay an order — the field is **optional** everywhere.

---

## 7. Technical requirements

| Area | Decision |
|---|---|
| Framework | **Next.js (App Router) + TypeScript** |
| Database | **PostgreSQL (Neon)** + **Prisma** — a new, separate project from Gift Valy |
| Auth | **NextAuth credentials** + custom RBAC layer |
| UI | **Tailwind CSS + shadcn/ui**, mobile-first, PWA-installable |
| Charts | **Recharts** |
| PDFs | Server-side PDF for invoice and packing slip, **embedded Bangla font** |
| File storage | Local `/uploads` (product images, order reference images), served through an auth-checked route — not a public static path |
| Image handling | `sharp` for compression + thumbnails on upload |
| Background jobs | Cron: Steadfast status sync (every 15 min), trash purge (daily), backup (nightly), low-stock alert (daily) |
| Validation | **Zod** on every API route; never trust the client |
| Deployment | VPS with PM2 + Nginx + Certbot (same runbook shape as the Gift Valy server migration), or Vercel + external `/uploads` storage |
| Backups | Nightly `pg_dump` to a separate location, retention 14 days |

### 7.1 Environment variables

```
DATABASE_URL=            # Neon pooled connection
DIRECT_URL=              # Neon direct connection (migrations)
NEXTAUTH_URL=
NEXTAUTH_SECRET=         # openssl rand -base64 32 — fresh, never reuse Gift Valy's
COURIER_ENCRYPTION_KEY=  # openssl rand -hex 32
CRON_SECRET=             # openssl rand -hex 32
UPLOAD_DIR=./public/uploads
MAX_UPLOAD_MB=5
```

---

## 8. Delivery plan

| Phase | Scope | Done when |
|---|---|---|
| **0 — Foundation** | Repo, Next.js + TS + Tailwind + shadcn, Prisma + Neon, NextAuth, RBAC engine, seed (roles, permissions, admin user, sizes, colours, categories), layout/nav | Admin can log in; an SE login sees a restricted nav |
| **1 — Core sales engine** | Products + variants + variant matrix · customers · **online order form incl. reference images** · order lifecycle · payments + due auto-calc · invoice PDF · packing queue + checklist + packing slip · "my orders" | An order can be taken from chat to packed, with a Messenger screenshot attached and visible to Packing |
| **2 — Stock, courier, money** | Purchases + weighted-avg cost + `stock_movements` · stock reports + low-stock alerts · courier module + Steadfast + COD reconciliation · payment verification + wallets + collection report · expenses | Stock and cash both reconcile against reality for a full week |
| **3 — POS, returns, exchanges** | POS walk-in screen + cash drawer · returns · **exchange module** · outfit sets/BOM | A walk-in sale and a size exchange both complete end to end |
| **4 — Intelligence & HR** | Leads + follow-ups · targets + leaderboard + rewards · attendance + leave · all dashboards · R1–R14 reports · P&L · audit-log viewer | Owner runs the day from the dashboard alone |
| **5 — Polish & go-live** | Steadfast webhooks in production · WhatsApp invoice send · PWA · backup cron · VPS deploy + SSL · staff training data | Live with real orders |

**Definition of done for every phase:** seeded demo data · role-tested (an SE login must never see cost or another SE's data) · Zod validation on every new route · audit log on every new sensitive mutation · backup script running · mobile layout checked on a phone-sized viewport.

---

## 9. Open items (defaults assumed — change if wrong)

| # | Item | Default assumed |
|---|---|---|
| 1 | Courier | Steadfast first; courier table ready for more |
| 2 | Payment methods | bKash, Nagad, Rocket, Bank, Cash, plus showroom Card |
| 3 | Staff count | Full role matrix seeded; unused roles stay empty |
| 4 | Database/repo | Fresh Neon project, fresh repo, nothing shared with Gift Valy |
| 5 | Occasion tag | Dropped for v1 |
| 6 | Image on PDF | Thumbnail on the **packing slip**, not on the customer invoice |
| 7 | Multi-branch | Single location in v1; schema must not block a second later |
