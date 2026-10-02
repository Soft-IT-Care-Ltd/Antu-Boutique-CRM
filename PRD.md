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

**Product** (the garment): name, **short code** (2–3 capital letters/digits, unique, e.g. `K12`; suggested from the name, editable until the first price tag is printed), category, brand/house, description, fabric, base selling price, product images (multiple), `is_active`, tags.

**Product Variant** (what actually has stock and price):

| Field | Note |
|---|---|
| `product_id` | parent garment |
| `size` | from the Size master list (Free, S, M, L, XL, XXL, or numeric), each with a 1–3 character SKU code (Free → `F`) |
| `color` | from the Colour master list, with a hex swatch and a 2–3 character SKU code (Maroon → `MRN`, Mustard Yellow → `MYL`) |
| `sku` | `<product code><size code><colour code>`, e.g. `K12MMYL` — no separators, **at most 9 characters**, unique; **locked once its first price tag is printed** |
| `stock_qty`, `reserved_qty` | on-hand and reserved (available = stock − reserved) |
| `weighted_avg_cost` | recalculated on every purchase |
| `price_override` | optional; falls back to product base price |
| `low_stock_threshold` | per variant, default from settings |
| `is_active` | |

- **Variant matrix screen:** pick sizes × colours, generate all combinations at once, set stock and cost in a grid.
- Size and Colour are **master lists in Settings** — so "Maroon" is one value, not five spellings.
- **Why SKUs are short** (decided P3.1, before real products went in). The SKU is what a price tag's Code 128 barcode carries and what the POS scan box reads back, and it must scan reliably on the smallest label, 38 mm at 203 dpi. That needs bars at least 2 printer dots (0.25 mm) wide: measured with one dot of thermal ink spread, 1-dot bars stop scanning while 2-dot bars keep reading. At 2 dots, with a 6-bar quiet zone each side, a 38 mm label holds 9 Code 128 characters. So SKU = product code (2–3) + size code (1–3) + colour code (2–3), **without hyphens**, which keeps every combination, XXL and Free included, within 9. Codes are suggested automatically (`lib/catalog/codes.ts`; a taken code is numbered: `MRN` → `MR2`) and can be typed. The database holds all of it: code lengths, SKU ≤ 9 capital letters/digits (CHECKs), and uniqueness.
- **Codes that join the same way.** Without separators, different codes can make one SKU: `K1` + `23` + `MRN` and `K12` + `3` + `MRN` are both `K123MRN` (numeric sizes make this real). The SKU is unique in the database, and every save that makes SKUs checks all of them first. When generating variants would reuse another product's SKU, the product moves to the next free code that avoids every clash (`K1` → `K13`), its existing SKUs are rebuilt, and staff are told why (audited as `catalog.product.code_auto_change`). If that product's tags are already printed, or two of its own size/colour pairs would read the same, nothing is saved and the message names the clash. A code typed by hand that would clash is refused with the same kind of message, not changed.
- **SKU lock.** Generating a price-tag PDF for a variant stamps `tagPrintedAt` and locks its SKU; a DB trigger refuses any later SKU change or un-locking. Until then the SKU follows its codes: changing a product, size or colour code rebuilds the affected SKUs in the same transaction (audited). Once any of them is on a printed tag, that code can't change either. A SKU can also be typed by hand (≤ 9 capital letters/digits) until its tag is printed.
- Low-stock alerts fire **per variant**, plus a product-level roll-up ("Kurti #12: only XL left").

**Outfit Set (BOM / package):** a sellable item built from **products**, each with a quantity per set (kurti ×1 + dupatta ×1 + plazo ×1). The **size and colour of each component is chosen when the set is sold**, online and at the POS — so "Kurti + Dupatta + Plazo" is one set, not one per size and colour. Its price is set independently. Cost = sum of the **chosen** variants' `weighted_avg_cost` × qty, frozen at packing like any line. **Available-to-sell for a chosen combination = min over components of floor(available ÷ qty)**; the set list shows the best combination. Selling an outfit set deducts every chosen component.

#### Decisions made during build (P3.3 — outfit sets and packaging)

- **Built from products, not variants** (`outfit_sets`, `outfit_set_components`: product + units per set, each product once). Components must be sellable products; a set needs at least two. Sets are soft-deleted; editing one never changes orders that already sold it.
- **On an order, a set is a set line plus ordinary lines.** `order_set_lines` keeps the set, its name when sold, qty, price and discount. Each component becomes an ordinary `order_items` row (`setLineId`): the chosen variant, units = units per set × sets sold, and its **share of the set price**, split by the components' list value (price × units) in whole paisa that add back exactly to the set line (`lib/sets/pricing.ts`; rounding goes into the component's line discount). So the order total is still the sum of its lines, and reservation, stock deduction, cost freezing, cancellation, partial delivery, returns and exchanges all work on the components exactly as on any line.
- **Chosen at order entry** (`components/sets/set-chooser-dialog.tsx`): the order form, the order edit and the POS offer sets by name next to products; adding one asks for a size/colour per component, showing each one's stock and how many sets the combination can fill. The server re-checks the set as it is now (`lib/sets/order-lines.ts`): every component chosen, each variant belongs to its product and is for sale.
- **Price floor and stock override apply to the set as a whole:** its price against the cost of the chosen combination (roles without cost can't go below it), and one override reason for its components.
- **Everyone who handles it sees the full explosion** (Gift Valy Round 2 §2.2): the packing queue, pack screen and packing slip list every component with its chosen size and colour under the set's name. The invoice and the 80 mm receipt show the set's name, qty and price with an indented list of what's inside — names, size, colour, qty; no component prices or costs. The order screen (staff) shows each component's share.
- **Component-level returns and exchanges** go through the P3.2 flows unchanged: one piece of a set can be returned or swapped (same product in another size keeps what that piece was worth inside the set); the other pieces are untouched. The return dialogs say which set a piece came from.
- **Availability report** (Catalog → Outfit sets → Availability report): for each set, how many can be sold on the best combination and **which component limits it**, with each component's best-stocked size/colour.

**Packaging materials** (optional in the prompt; kept — Antu uses branded bags, boxes, tissue and tags):
- A product's **type** is *For sale* or *Packaging material* (`products.kind = COMPONENT_ONLY`), chosen at creation. Packaging material is stocked (purchases, adjustments, write-offs, stock reports) and costed like any product, but has **no selling price** (DB CHECK), never appears in order or POS search, can't be sold, put in a set, or used as a replacement, and gets no price tags.
- **What an order uses** (`packaging_components`, exactly one owner — DB CHECK): per unit of a product (a box per saree, a tag per garment — inside sets too, so a set never repeats its products' packaging), per set (the set's gift box), and **per online parcel / per showroom sale** (a mailer bag; a shopping bag and tissue — Catalog → Packaging).
- **When it leaves stock:** when an online order is packed (`lib/orders/pack.ts`), and at the counter when a sale or a counter exchange's replacement is made — as `PACKAGING_OUT` ledger rows in the same transaction (invariant 2). Running short never blocks packing: stock goes negative and shows as a shortage. Packaging is used up — a cancellation or return never puts it back. The pack screen and slip list the packaging to use (or used).
- **Its cost reaches P&L once**, as one **"Packaging used"** expense per order (system category, Packaging heading, no wallet; `expenses.packagingOrderId` unique), at the weighted average cost when it's used. Buying packaging is a `PURCHASE` like any stock (cash-out only), so it isn't counted twice. Per-order profit's "packaging cost" is that order's Packaging used expense.

### 4.3 Inventory

- **Stock is held per location** (CORRECTIONS.md item 2, C3): per *(variant, location)*; a variant's total stock is the sum over its locations **+ in transit** (C4 — units on a transfer between sending and receiving count in the total but belong to no location).
- **Purchase entry:** supplier, date, invoice no., per-variant qty and unit cost **and the location each line is received at** (default: the packing hub), transport/other cost allocation, payment made/due.
- **Weighted average cost** recalculated on every purchase: `new_wac = (old_qty × old_wac + in_qty × in_cost) ÷ (old_qty + in_qty)` — one cost per variant, over all locations.
- **`stock_movements` ledger is immutable and append-only.** Types: `PURCHASE_IN`, `SALE_OUT`, `RETURN_IN`, `EXCHANGE_OUT`, `EXCHANGE_IN`, `DAMAGE_OUT`, `ADJUSTMENT`, `POS_SALE_OUT`, `PACKAGING_OUT` (P3.3: packaging used at packing or at the counter), `TRANSFER_SEND`, `TRANSFER_RECEIVE`, `TRANSIT_WRITE_OFF` (C4). Every row: variant, **location** (none = in transit — transfer rows only), qty (+/−), reference type/id, unit cost snapshot, actor, timestamp, note.
- **Stock and its ledger row are written in one database transaction.** Never one without the other. For each variant at each location, stock = the sum of that location's ledger rows; in transit = the sum of the rows with no location.
- Manual stock adjustment requires a reason and is Admin/Manager (or that location's manager) only; it happens at one location.
- Damage/write-off posts `DAMAGE_OUT` at one location and an expense line at cost.

#### Decisions made during build (C3 — locations and per-location stock)

- **Locations** (`locations`, Settings → Locations, `settings.manage`): name, type (Warehouse / Shop / Sales corner / Studio), address, **packing hub** (exactly one — a partial unique index allows only one, and the hub can't be switched off or un-set, only moved to another location), **has POS**, active. Started with Mohammadpur Warehouse (packing hub), Shyamoli Showroom (the only POS), Parlour Sales Corner and Studio (fixed ids `loc_*`, created by the migration so the base seed has them too). Switched off, never deleted; a location still holding stock can't be switched off. Every change is audited, managers included.
- **Storage.** `variant_stocks (variantId, locationId, qty)` holds each location's stock; `product_variants.stockQty` stays as the **total** (the sum), so everything that works on total stock — online reservations, low-stock alerts, outfit-set availability, catalog badges — reads it unchanged (CORRECTIONS "Changes to existing rules" 8). `stock_movements` carries `locationId` and `locationStockAfter` (the location's running balance) next to `stockAfter` (the total's). `recordStockMovement` (`lib/inventory/ledger.ts`) is still the only writer: it moves the variant's total, that location's row and the ledger in one transaction.
- **The database enforces it.** Besides the existing per-variant trigger (total = sum of all its rows), a deferred constraint trigger checks at COMMIT that each `variant_stocks` row equals the sum of its location's ledger rows — so stock moved between locations by hand, or a row booked to the wrong location, can't commit. `variant_stocks` rows are never deleted or re-pointed (trigger). The Inventory screen's ledger check covers every variant at every location.
- **Existing stock** (everything before C3) was booked to Mohammadpur Warehouse: the migration filled `locationId` on every existing ledger row (the append-only trigger lifted for that one statement — quantities, costs and references untouched) and built `variant_stocks` from the ledger, so the invariant held from the first commit.
- **Where each movement happens.** Packing (`SALE_OUT` / `EXCHANGE_OUT`) deducts from the **packing hub**, and is refused when the hub doesn't hold every unit — the message names where the stock is (transfer it to the hub — C4). Cancelling after packing restocks where it was packed from. Courier returns and online exchanges are restocked (or written off) at the hub; a counter exchange takes the item back into, and the replacement out of, the POS showroom. Parcel packaging leaves the hub, counter packaging the showroom. Purchases, adjustments and write-offs name their location; an adjustment or write-off can't take that location below zero (whatever the others hold), but adding to a negative location is how it's put right.
- **Reservations stay against total stock** (item 2): reserving and releasing never name a location.
- **Location managers** (`user_locations`, set on Settings → Locations): they act — adjustments, write-offs, purchases received, opening stock, and (C4) transfers and counts — only for their locations. `location.all` (Admin and Manager templates) acts for every location. **Seeing stock is not scoped**: the stock lookup shows every location to anyone with `inventory.view`, so an SE can tell a customer where a dress is.
- **Opening stock per location** (item 4): the product page's **Opening stock by location** grid lists the sizes/colours that have never held stock — one column per location the user acts for, plus a unit cost per row. Saving posts one `ADJUSTMENT` / `OPENING_BALANCE` row per location in one transaction (audited as `product.opening_stock`), and the cost becomes the variant's average cost; no expense. Needs `product.create` + `product.cost.view`. After that, stock comes in by purchase. The CSV import gains a `location` column (blank = the hub); a size/colour may repeat on another row for a second location.
- **Stock lookup** (`/inventory/lookup`, item 2): type or scan a SKU (a scanner's exact SKU comes back alone), or search a name → every location's quantity, in transit (C4), total, reserved and available. Cost-free; built for a phone.
- **Stock screens.** The stock report shows each variant's split by location and filters by location (on hand and value at cost then that location's; reserved and available stay shop-wide). The ledger shows and filters by location, with the location's and the total's balance after each row. The R4 stock report has a *By location* column. Purchase detail shows where each line was received.
- **Negative stock** (item 11): see §4.7. `/inventory/negative-stock` lists every (variant, location) below zero — a location manager sees their own locations, `location.all` sees all — and a `NEGATIVE_STOCK` in-app alert goes to that location's managers and everyone with `location.all` (once per variant, location and day).

#### Decisions made during build (C4 — transfers, stock in transit, scan receiving and scan counting)

- **Transfers** (`stock_transfers`, `stock_transfer_lines`, `stock_transfer_orders`; `/inventory/transfers`, item 3): number `TR-YYMM-NNNN` (`document_sequences`, locked per month like order numbers), from, to, created by, lines (requested / sent / scanned in / received / found / written off). **Draft → In transit → Received**, or **Received with difference**; only a Draft can be **Cancelled** (nothing has moved). Only the source location's people (`transfer.send`) scan out and send; only the destination's (`transfer.receive`) scan in and receive; `location.all` does both. Every action locks the transfer row first, so a scan can't land on a transfer being sent or received.
- **Stock moves in pairs, and the total never changes.** Send posts `TRANSFER_SEND` −n at the source and +n **in transit** (a ledger row with no location); Receive posts `TRANSFER_RECEIVE` −n in transit and +n at the destination. `product_variants.inTransitQty` holds the in-transit figure: `stockQty = sum(variant_stocks) + inTransitQty = sum(all ledger rows)`. Deferred triggers check in transit against its rows at COMMIT, and a CHECK allows a location-less row only for the three transfer types. Lines move at the weighted average cost at send (kept on the line, stripped for non-cost roles). Sending more than the source shows is refused (scan by scan, and again under lock at Send) — count the location first. Reservations stay on the total, so a transfer never touches them.
- **Scanning.** One scan = one unit. Sending: a tag the source doesn't have enough of is refused. Receiving: a tag that isn't on the transfer, or one scanned more times than were sent, is refused with a loud red message. Nothing moves until Send / Receive; quantities can also be typed or taken back (−/+).
- **Differences.** Units sent but not scanned in stay **missing in transit** (still in the total, at no location) until a manager (`transfer.resolve`: Admin, Manager) marks them **found** (received onto the destination then) or **writes them off** (`TRANSIT_WRITE_OFF`, an expense at the line's cost under **Stock shortage**). Each needs a reason. Send, receive, found, write-off and cancel are audit-logged. The list has a *Missing in transit* tab.
- **Needed at the packing hub** (`/inventory/hub-needs`, feeds item 13): confirmed online orders (the ones holding a reservation and still to be packed) get the hub's supply — its stock plus everything already coming to it (in transit, and Drafts raised for it) — **oldest order first**; what's left short is offered from each other location's stock, again oldest first (a Draft's units are promised, so its sender can't offer them twice). The location's manager ticks items → one Draft transfer to the hub, pre-filled (*requested*) and linked to those orders; the server re-checks every pick against the list as it is now. When a transfer is drafted or received the orders drop off by themselves. (The orders' own *Needs transfer* / *Ready to pack* status is C5.)
- **Purchase receiving by scan** (item 2): the purchase form has a *Receive by scan into [location]* box — each scan adds one unit of that SKU at that location (a repeat scan raises the line's quantity); costs are entered as before.
- **Stock count by scan** (`stock_counts`, `stock_count_lines`, `/inventory/counts`, item 2): `SC-YYMM-NNNN`, one location. A **Spot count** compares only what was scanned (a shelf, a rack); a **Full count** also takes off anything the location shows that wasn't scanned. Counting needs `stock.count` at that location (the hub's packer, the showroom's POS operator); **posting** needs `inventory.adjust` (Stock shortage rules). Audit-logged.
  - **What a line is compared with:** a scan records the shelf *at the moment it was scanned*, so each line's expected figure is **the location's stock for that variant at its last scan** (or when its figure was typed in) — read under the variant's lock and kept on the line (`stockAtScan`). That equals today's stock minus every ledger movement at that location for the variant after the last scan. Posting adds counted − expected to today's stock as an `ADJUSTMENT` referencing the count, with its Stock shortage expense. So a POS sale or a received transfer between scanning and posting is never booked as found or short; a sale *before* the scan is already out of both figures. (Scan all of one item together: a unit sold from the scanned pile mid-count can't be told apart.)
  - **Full count, items nobody scanned:** counted as none. Each is taken off (expected = its stock at posting) **only if nothing moved it at that location since the count opened** (`stock_counts.openedAtSeq` against the ledger's increasing `stock_movements.seq`). If it was sold, received or transferred during the count, nobody can tell whether the counter passed it before or after, so it is **left unchanged** and shown/audit-logged as "moved during the count — scan it" for a recount. The count never guesses an expense.
- **Every scan screen** (transfer send/receive, purchase receiving, stock count) uses one scan box (`components/scan/scan-box.tsx`): a USB/Bluetooth scanner in keyboard mode types the SKU + Enter into it (Caps-Lock and CR/LF/Tab suffixes are undone, a Bangla keyboard is detected); scans are processed in order; a good scan chirps, a refusal buzzes twice. **Camera fallback**: the phone camera reads the tag's Code 128 (`@zxing`, loaded only when opened — iOS Safari has no BarcodeDetector); it needs an https link (or localhost).
- **Where in transit shows**: stock lookup (*In transit*), the stock report and R4 (*In transit n* next to the locations), and the ledger (location *In transit*, filterable). Period in/out on R4 leaves transfers out — they only move stock between places.

#### Decisions made during build (C4b — shelves inside a location, CORRECTIONS.md item 20A)

- **A "where is it" layer, never part of stock or money.** A location that **uses shelves** (Settings → Locations; on for the Mohammadpur hub, off for the Shyamoli showroom — a location without them shows no shelf screens and no *Unassigned*) is divided into shelves with codes like `A-2-3` (rack A, shelf 2, box 3). `shelf_stocks` holds how many of a variant sit on each shelf. Shelf moves never write `stock_movements` and never post money; they are logged in `shelf_movements` (history only).
- **Unassigned is derived, never stored:** *location stock − sum of that location's shelves*, so it cannot drift. Arriving stock (purchase, transfer received, return, exchange, count found) lands there until put away. **The database holds the rest:** a shelf quantity is never below zero (CHECK), and per (variant, location) *sum(shelves) + units not on their shelf ≤ max(location stock, 0)* — deferred constraint triggers on `shelf_stocks`, `shelf_misses` and `variant_stocks`, checked at COMMIT like the ledger triggers. `lib/shelves/engine.ts` is the only writer of the shelf tables.
- **Stock leaving a location leaves its shelves in the same transaction** (`recordStockMovement` → `takeOffShelves`), for every exit — packing, POS sale, transfer send, damage, adjustment, count. Units **picked off a known shelf** (a shelf label scanned before the dress on the transfer-send screen; C5's pick lists) come off that shelf; the rest come out of **Unassigned first** (waiting units, then units not on their shelf), **then off the shelf holding the most** of that variant (ties: shelf order).
- **Shelf codes and labels.** Codes are 2–4 parts of capital letters/digits joined by hyphens (DB CHECK). The hyphen is required: a SKU never has one, so every scan box at a shelf location tells a shelf label from a dress tag with no mode switch. Managers (`shelf.manage`) add shelves one by one or a whole rack at once and print **shelf labels** (Code 128 of the code, the code printed big, the location name) on the price tags' label sizes and printers.
- **Put away / move by scan** (`/inventory/shelves/put-away`, `shelf.putaway` at one's own location — the hub's packers, the showroom's POS operator): scan the dresses, then the shelf label → they go on that shelf, from Unassigned first (a unit not on its shelf is thereby *found*), then from the fullest other shelf. To move from a particular shelf, scan that shelf's label first. More than the location holds can never be put on a shelf.
- **Counting one shelf** (`shelf_counts`, `stock.count`): scan the shelf, scan everything on it. Same rule as a location count — each line is compared with **the shelf's figure at its last scan** (read under the variant's lock), and the difference is applied to the figure now, so a sale or a shelf move during the count never shows as a difference; an item the shelf shows that nobody scanned counts as none unless it moved on that shelf during the count (`shelf_movements.seq` after the count opened), then it is left alone. The counter finishes the count — it never changes stock: **missing units go "not on its shelf"** (`shelf_misses`, still in the location's stock — the dress may be on another shelf), extra units are brought onto the shelf from Unassigned / not-on-its-shelf / the fullest other shelf, and anything beyond the location's stock is reported for a location count (only a location count adds stock).
- **"Not on its shelf" is the manager's.** Units leave that list when found (put away), when they leave the location (Unassigned is used first), when a **location count** for that variant is posted (it settles how many are in the building — a shortage is posted as usual), or when a manager (`inventory.adjust`) **writes them off** — the only shelf-driven path to the Stock shortage expense. Shelf create/change, finishing a shelf count and a write-off are audit-logged.
- **The shelf shows wherever someone looks for a dress:** stock lookup (each shelf location's shelves and Unassigned), the order screen (lines of orders still to be packed), and the packing queue, packing screen and packing slip (where it sits at the hub, fullest shelf first). Switching a location's shelves off drops its shelf figures (audit-logged); stock doesn't move.

### 4.4 Customers

- One person: name, **primary phone (unique)**, optional alternate contact number, address (division / district / thana / detail), notes, tags (VIP, wholesale, problem-customer).
- **No payer/recipient split, no second person, no country field, no sender message.**
- Auto-dedupe on phone number at order entry: typing a known number pulls up the existing customer with their order history.
- Customer profile shows lifetime orders, lifetime value, returns/exchanges count, average order value, last order date, and a **risk flag** (e.g. 3+ refused COD deliveries).
- Profile also shows the customer's **store credit** balance and ledger (P3.2, §4.11).

### 4.5 Leads & follow-ups

- Source: Facebook Ad, Messenger, WhatsApp, Instagram, Referral, Repeat Customer, Showroom Walk-in, Other. Optional campaign name.
- Status funnel: `NEW → CONTACTED → FOLLOW_UP → NEGOTIATING → CONVERTED → LOST`, with required lost reason (price, size unavailable, no response, bought elsewhere, other).
- Follow-up reminder with date/time; "my follow-ups due today" list on the SE dashboard; overdue follow-ups highlighted.
- Bulk daily-count quick entry (for days when leads are counted, not individually recorded).
- Converting a lead pre-fills the order form and links `order.lead_id`.
- Conversion-rate reporting per SE, source, and campaign.

#### Decisions made during build (P4.1 — leads and follow-ups)

- **A lead needs only a name and a source.** Phone, campaign (free text, suggested from ones already used; reports group it ignoring case and spacing), "interested in" and notes are optional — a Messenger enquiry often has only a profile name. A phone that matches a customer the executive can see links the lead to that customer and offers "Repeat customer" as the source.
- **Ownership and scope** follow customers and orders: the creator owns the lead (`createdById`, `teamId` copied from them), and every list, detail, follow-up list, report and export runs through the shared scope helper. Conversion credit in reports goes to the lead's owner, whoever places the order.
- **Funnel rules** (`lib/leads/status.ts`): the four open stages move freely in any direction; any open lead can be marked **Lost** (reason required, a written note required for "Other" — also a DB CHECK); a lost lead can be **reopened**, which clears the reason. **Converted is never picked by hand** — it is set only by placing the lead's order, so every converted lead has an order behind it. A converted lead is final and can't be deleted.
- **Follow-ups** (`lead_followups`) are reminders with a Dhaka date/time and an optional note; marking one done records what happened and can set the next one in the same step. Setting a follow-up on a New/Contacted lead moves it to Follow-up. A lead can have several. Overdue = past its time and not done; overdue ones are red everywhere. When a lead is converted or lost its open reminders simply stop showing (reopening brings them back).
- **"Due today"** = open follow-ups due before Dhaka midnight, overdue first. It's a card on the dashboard ("My follow-ups due today" for an executive, the team's for a TL, everyone's for Admin/Manager — the full role dashboards are P4.3), plus a Follow-ups tab covering the next 7 days.
- **Conversion**: "Convert to order" opens the order form pre-filled (the lead's customer if it has one the user can see, else its name and phone; "interested in" goes into the internal note). Placing the order sets `order.lead_id` and closes the lead as Converted **in the same transaction**; `orders.leadId` is unique, so a lead converts once. A lost lead that comes back can be converted directly. Needs `lead.convert` and `order.create`.
- **Daily counts** (`lead_daily_counts`): one sheet per person per day — leads and "bought" per source, optionally per campaign. Saving replaces that day's sheet (audit-logged with before/after). An executive counts their own days; a TL for their team; Admin/Manager for anyone. No future days.
- **Conversion report** (Leads → Conversion, `lib/leads/report.ts`) is a **cohort**: leads that came in during the period (recorded ones by the day added, counted ones by the day counted) and how many have bought since. Recorded and counted leads add together; open/lost apply only to recorded leads. Also shows lost reasons and the value of the (not cancelled) orders recorded leads turned into. CSV export needs `report.export`. R2 in P4.4 builds on this.

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
plus `ON_HOLD`, `CANCELLED`, `RETURNED`, `REFUNDED`, `EXCHANGE_REQUESTED`, and `PARTIAL_DELIVERED` (courier-reported partial delivery — see §4.9 decisions).

- Stock is **reserved at `CONFIRMED`** and **deducted at `PACKED`** (with `unit_cost_snapshot` frozen at that moment).
- Cancelling before `PACKED` releases the reservation; cancelling after `PACKED` restores stock via a ledger row.
- **Edit window:** an SE may freely edit an order for X minutes after creation (default 30, set in Settings). After that, any edit that changes items, price, discount or delivery charge needs **TL/Admin approval** — the edit is queued as a request, and an approved edit regenerates the invoice as a new version.
- Full status history / audit trail per order: who moved it, when, from what to what.

**Orders list — status tabs (CORRECTIONS.md item 14, C2).** Statuses are tabs with counts, not a dropdown: Needs confirmation (LEAD) · Waiting for stock · Needs transfer · Ready to pack (CONFIRMED) · On hold · Packed · With courier (sub-tabs Handed over / In transit / Approval pending — IN_TRANSIT whose shipment is `*_APPROVAL_PENDING`) · Delivered (incl. partial) · Completed · Returns & exchanges (sub-tabs Returns / Exchanges) · Cancelled · All. *On hold* isn't in the owner's list but is open work, so it has its own tab rather than vanishing. Open-work tabs (Needs confirmation → With courier) show every open order whatever the date filter says; finished tabs and All follow it, default **This Month**. Each tab's count and rows are built from one where (`lib/orders/tabs.ts`, `orderTabWhere`), inside the caller's scope. *Waiting for stock* and *Needs transfer* are fulfilment states that need per-location stock and backorders (C3/C5); until then they are empty and every confirmed order is *Ready to pack* (the packing queue). A dashboard link naming a status opens that status's tab.

### 4.7 POS — walk-in / showroom sale

- Separate fast screen: product/SKU search or barcode field → cart → quantity → discount → payment (Cash/bKash/Nagad/Card) → done.
- Channel is `WALK_IN`. **No courier, no delivery address required.** Customer record optional (walk-in can be anonymous, or a phone number captures them for repeat tracking).
- Stock deducts **immediately** on sale (no `CONFIRMED` reservation step); status goes straight to `COMPLETED`.
- Prints/skips an invoice; posts to the same payments, wallets and P&L tables as online orders.
- Daily showroom cash drawer: opening balance, cash sales, cash out, closing balance, with a cash-reconciliation screen at day end.

#### Decisions made during build (C3 — the POS sells from its showroom's stock)

- **A POS sale deducts from its showroom's location** (CORRECTIONS.md item 11; the POS location is the active location with *has POS* — the one the user is assigned to, or the only one). Search and scan show what **that showroom** holds, not shop-wide availability.
- **Selling with no stock showing** (replacing invariant 7 at the POS): if the cart holds more than the showroom shows, the operator sees a warning on the line and, on completing, a confirmation listing each short item; confirming ("it's in hand") completes the sale. No manager permission is needed. The showroom's stock goes negative, the line is marked as a stock override with the reason "Sold with N showing at … — stock went negative", the sale's audit row lists the shortages, and the location's managers and `location.all` holders get a **Negative stock** alert. The same applies to a counter exchange's replacement. Reservations for online orders are not the POS's to protect any more — fulfilment (C5) sorts out an online order whose unit was sold at the counter.

#### Decisions made during build (P3.1 — POS, cash drawer, price tags)

- **One transaction per sale** (`lib/pos/sale.ts`). A walk-in sale is created straight at `COMPLETED` (status history `— → COMPLETED`), channel `WALK_IN`, no courier, no delivery charge. Each line's `unit_cost_snapshot` is frozen at the sale, at the weighted average cost its `POS_SALE_OUT` ledger row carries. It never passes through `CONFIRMED`, so it reserves nothing and never receives allocated ad cost.
- **Anonymous or linked customer.** `orders.customerId` is nullable for walk-in sales only (DB CHECK `orders_customer_required_online_chk`: every `ONLINE` order still has its one person). A phone number links the sale to the customer with that number, whoever created them (dedupe on phone, §4.4). The existing record is never renamed and never shown to the operator. A new number creates a customer (name optional, "Walk-in customer" by default).
- **Paid in full at the counter.** Tenders (Cash / bKash / Nagad / Card, split allowed) must pay the total exactly, so `due_amount` is 0 (recomputed, invariant 1). Cash may be over-tendered: the change is shown and noted on the payment. A cart-wide discount is spread over the lines pro rata (largest remainder, whole paisa), so every line keeps its own discount and per-line profit stays true. Price floor and the stock-override rule (invariant 7) are the same as the online form.
- **80 mm receipt, A4 invoice on demand.** Right after a sale the counter prints an 80 mm thermal receipt (`lib/pos/receipt.ts`: shop name, date, items with size and colour, discount, total, each payment method, cash given and change, a thank-you line in Bangla and English). It's a PDF exactly as tall as its content, rendered on request and never stored, so a reprint is always identical. The cash handed over is kept on the payment (`payments.cashTendered`, CASH only, never below the amount — DB CHECK). The A4 invoice stays an option: it's made as version 1 the first time it's asked for, and skipping it costs nothing. It shows no address, "Walk-in customer" when anonymous, and how the sale was paid.
- **The cash drawer is the Showroom Cash wallet, counted** (`lib/pos/drawer.ts`, table `cash_drawers`, one per business day, one open at a time). What it should hold = opening count + that day's cash payments into the wallet (POS and any other cash taken at the counter, verified or not) − approved cash refunds − expenses paid from it ± manual entries and transfers. These are the same rows the wallet balance is derived from. The drawer wallet is setting `pos_cash_wallet_id` (default Showroom Cash).
- **Cash needs today's drawer open.** A cash sale holds the drawer row `FOR SHARE`; closing takes it `FOR UPDATE`, so no cash can land between the count and the close. Yesterday's drawer must be closed before today's opens. Card, bKash and Nagad sell without a drawer.
- **Cash in/out at the drawer** (permission `pos.drawer`, POS operator): a deposit to another wallet (transfer), a petty expense (a normal expense, non-system categories only), other cash out, or cash added. Only from the drawer's wallet, only dated today, never more than the drawer should hold. Each goes through the normal wallet or expense service and is audited there.
- **Day-end count.** Closing needs a note when the count differs. It freezes the expected figure. **The count verifies that day's cash payments** into the wallet (audited as `payment.verify` via `cash_drawer_close`); card and mobile payments stay in the Accounts queue. **The difference posts once** as a **"Cash over/short"** expense (`CASH_OVER_SHORT`, a system category) from the wallet: a shortage is a cost, an overage a credit (negative, allowed by `expenses_amount_sign_chk` for drawer rows only). So the wallet follows the counted cash, and P&L sees cash losses under their own heading, apart from stock shortage.
- **An opening count** that differs from the last counted close needs a note but posts nothing (it may be a top-up). Any gap between the wallet's books and the count is shown on the reconciliation screen for Accounts to fix with a wallet entry. Money recorded for a closed day after its count is flagged "after close" there.
- **Channel filter.** Orders list, payments lists (verification, refunds, history) and the collection report filter Online / Walk-in; the collection report also breaks totals down by channel. The expense report has no channel: expenses aren't tied to orders.
- **Price tags** (`/catalog/price-tags`, permission `product.tags.print`). Each tag carries product name, size, colour, selling price and a **Code 128 barcode of the SKU, exactly**, plus the SKU in text. Tags are chosen by variant, a whole product (one per piece on hand), or everything a purchase received (one per piece). Label-printer stock is printed one label per PDF page at the label's size (50×25, 40×30, 38×25, 60×40 mm; 203/300 dpi); sheet stock is A4 at 24, 40 or 21 up, with a start position for half-used sheets. Bars are snapped to the printer's dot grid and are never narrower than 2 dots (0.25 mm); every SKU (≤ 9 characters, §4.2) fits the smallest label that way. Printing locks each tagged variant's SKU.
- **What the tag prints is what the POS reads.** SKUs are held to 9 capital letters and digits (§4.2; edits are upper-cased and validated), which Code 128 carries and a keyboard-mode scanner types back unchanged. The POS scan box normalises the scan (strips Tab/CR/LF, undoes Caps Lock) and does an exact SKU lookup before any type-ahead match. A Bangla keyboard layout is detected and the operator is told to switch. Verified by an encode→decode test for every seeded SKU and by decoding rendered 203 dpi tags with an independent barcode reader.

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
- **Shelf codes** (C4b): when the hub uses shelves, every line on the queue, the packing screen and the slip shows where it sits — fullest shelf first, then how many are Unassigned. Packing takes the units off Unassigned first, then the fullest shelf (C5's pick list will name the shelf it was picked from).

### 4.9 Courier & delivery

- Courier company table: name, contact, **per-zone delivery charge** (inside city / sub-city / outside city), COD charge %, return charge.
- Shipment record per order: courier, consignment/tracking ID, booked at, status, delivery charge, COD amount, COD received at.
- **Steadfast integration** (same pattern as Gift Valy's `STEADFAST_INTEGRATION.md` — reusable almost as-is): create consignment from the order screen, webhook for status updates, plus a polling reconciliation cron every 15 minutes as a safety net.
- Courier API credentials stored **encrypted** with `COURIER_ENCRYPTION_KEY`.
- **COD reconciliation:** courier statement (manual entry or CSV import) matched against orders; shows collected / not yet received / short; discrepancies flagged for Accounts.
- Return flow from courier: `RETURNED` → condition check by Packing → restock (`RETURN_IN`) or write-off (`DAMAGE_OUT`) → courier return charge posted as an expense.

#### Decisions made during build (P2.2)

Recorded so later phases (P&L, reports, exchanges) build on the same rules.

- **Live-API safety switch — `STEADFAST_LIVE_API`.** All Steadfast HTTP calls go through one client module (`lib/courier/steadfast/client.ts`). Booking consignments and the status API are refused unless `STEADFAST_LIVE_API=enabled`, which is set **on the production server only**. Test Connection and the balance (`GET /get_balance`) always work. A developer machine can therefore never book a real parcel, even by accident.
- **Stricter webhook confirmation than Gift Valy.** Steadfast's webhook says `delivered` / `partial_delivered` / `cancelled` when the *rider* marks the parcel, before hub approval (Gift Valy Round 2 §2.6). A final webhook status is only applied once the status API confirms the same final status. If the API reports `*_approval_pending`, the order stays `IN_TRANSIT` with that sub-status. If the API is unreachable or disagrees, the order is **also** held at the approval-pending stage and the shipment is flagged `needs_attention`; the 15-minute poll finalizes it once the API confirms. An order never reaches `DELIVERED` / `RETURNED` on an unverified webhook. (Gift Valy trusted the webhook when the cross-check failed.) Steadfast's zone-less timestamps are read as Asia/Dhaka and stored UTC (Round 2 §2.5).
- **Courier cost formula.** Courier cost (what *we* pay) is separate from the customer's delivery charge on the order. Per zone (Inside / Sub / Outside Dhaka): `base` covers the first kilogram, and each further *started* kilogram adds `per-kg` — cost = base + per-kg × (⌈weight kg⌉ − 1), with a missing weight treated as ≤ 1 kg. Weight is the sum of the variants' optional unit weights (grams). This estimate is stored per shipment; the courier's actual `delivery_charge` (webhook) overrides it, and P&L uses actual when known, else the estimate.
- **Partial delivery — `PARTIAL_DELIVERED`.** Set only by the courier sync, never by hand. The shipment is flagged for ACCOUNTS, and staff record how many of each item the customer kept. Each line keeps its original `qty`; `returned_qty` records the rest. The order total is recomputed on the kept quantities, with line discounts pro-rated, and `due_amount` is recomputed from it (invariant 1). When the total changes, **the invoice is regenerated as a new version and old versions are kept** (invariant 8). The returned units go to the Packing condition check.
- **Condition check and the courier return charge.** One reusable service (`lib/returns/condition-check.ts`) handles every return: courier returns, partial deliveries and, from Phase 3, exchanges. Good → `RETURN_IN` (`EXCHANGE_IN` for exchanges); Damaged → `RETURN_IN` then `DAMAGE_OUT` + an expense. Both are valued at the line's frozen `unit_cost_snapshot`. `RETURNED` alone never restocks. For a courier return, the courier's return charge is **posted once as an expense when the condition check completes**. It uses Steadfast's reported charge for that parcel, else the zone's configured return charge. If the payout covering that parcel was **already reconciled** (its delivery-charge expense already includes the charge), nothing is posted. **P&L must not count that charge again** as the returned shipment's courier cost.
- **Rider note.** Orders have a separate *delivery instructions* field (`delivery_note`). It is the only text sent to Steadfast as the consignment `note`, which the rider reads. The internal staff note is never sent.
- **Status moves are claimed atomically** (Verify Phase 2). `moveOrderStatus` only moves an order that is still at the status the caller read. Two packers on one order, or a cancel racing a pack, can't both act: the loser's transaction, stock movements included, rolls back.
- **Only `LEAD` / `CONFIRMED` orders are edited.** That includes approving an edit request that was filed while the order was `CONFIRMED` but approved after it was packed. Rewriting packed lines would lose their frozen cost and release reservations that no longer exist.
- **Manual status moves after booking.** Once an order has a Steadfast consignment, it cannot be moved by hand into `IN_TRANSIT`, `DELIVERED`, `PARTIAL_DELIVERED` or `RETURNED`; those come from the courier sync. The one exception is an **Admin-only override** (`order.courier_status_override`) for when the courier API is down or a parcel is lost. It needs a written reason, is written to the audit log as `order.courier_status_override`, and stops status polling for a final status. A later webhook reporting a different outcome is flagged for attention.

#### Decisions made during build (P2.2b — COD reconciliation and payouts)

- **One statement model for every source.** `courier_statements` / `courier_statement_lines` hold Steadfast payouts synced from its API, CSV imports and manually typed statements, and all three go through one reconciler (`lib/courier/reconcile.ts`). A statement is unique per courier + reference, so re-syncing or re-importing never duplicates money.
- **Matching and judging.** A line matches our shipment by consignment id, else by order no. It matches when the courier's gross COD equals ours within **±৳2**; when the courier's net for that parcel can be derived, that net must also equal our expected net receivable within ±৳2. Expected net = COD − delivery charge (actual if known, else estimate) − COD fee, where the COD fee is the zone's COD % of (COD − delivery charge); this matches Steadfast's real invoices. A returned parcel is expected at COD 0. A partial delivery is expected at the COD the rider reported collecting.
- **Settlement is gross, charges are expenses.** A matched line creates one verified `COURIER_COD` payment for the courier's gross COD, capped at what's still due. The customer did pay the full COD; the courier's delivery charge and COD fee are business costs, never deducted from the order. `due_amount` is recomputed (invariant 1). A `DELIVERED` order with nothing due then auto-moves to `COMPLETED` (a `PARTIAL_DELIVERED` one only after the Accounts review).
- **Discrepancies move no money.** A mismatch or a double-settlement attempt flags the line and the shipment for ACCOUNTS. Accounts can **accept** the courier's figure (reason required; settles it, any shortfall stays due on the order) or **dispute** it (reason required; nothing moves). A parcel that isn't ours stays *unmatched*: it can be disputed but never accepted.
- **Charges are expensed once, only on a fully justified statement.** When every line is matched or accepted, the statement's delivery charges and COD charges post as expenses once. The delivery-charge expense **excludes return charges the condition check already posted** for parcels on that statement, so no charge is booked twice. **P&L:** monthly P&L takes courier costs from these expenses plus the return-charge expenses; per-order profit uses the shipment's courier cost (actual, else estimate). A report must not add both into the same figure.
- **Statement payments are locked.** A payment created by reconciliation can't be edited or deleted from the order's payments panel. `COURIER_COD` can't be picked when recording a payment by hand.
- **Payouts sync.** Runs hourly on the 15-minute Steadfast cron (and on demand with "Sync Steadfast payouts"). `/payments` is oldest-first with no paging metadata, so the sync finds the last page and walks back only to payouts dated after our first Steadfast shipment. Each payout's detail is fetched once. It is subject to the `STEADFAST_LIVE_API` switch like every call except the balance.
- **Who sees what.** The reconciliation screens are for `courier.reconcile` (Accounts, Manager, Admin) and show the courier's charges, which Accounts needs to reconcile. Shipment courier-cost fields stay stripped for roles without `product.cost.view`.
- **Rider info** is not scraped from Steadfast's tracking page. In-transit parcels show "Rider: —" with a link to the tracking page (Gift Valy Round 2 §2.4 fallback).
- **Limit:** statement lines only match parcels that have a shipment in the system. Today that means Steadfast bookings. Reconciling another courier's statement needs its handovers recorded as shipments first (not built yet).

### 4.10 Payments & wallets

- **Multiple payments per order**: advance, partial, COD collection, post-delivery settlement.
- Each payment: amount, method (bKash / Nagad / Rocket / Bank / Cash / Card), wallet, transaction ID, paid at, received by, verified flag, note.
- **Transaction ID is globally unique** across the system (prevents the same bKash TrxID being used twice). It is stored trimmed and upper-cased, and a database CHECK holds every row to that form, so the unique index can't be dodged by typing `8n7a…` for `8N7A…`.
- Accounts verifies payments; unverified payments show in an "awaiting verification" queue.
- **`order.due_amount` is recomputed on every payment write, never typed by a human.**
- Wallets (bKash personal, bKash merchant, Nagad, bank account, showroom cash) with running balances, manual in/out entries, and a wallet statement per date range.
- Refunds recorded as negative payments with a reason and approval.
- **Store credit** (P3.2) is also a payment method: it moves no money and has no wallet — see §4.11 *Store credit*.

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

#### Decisions made during build (P3.2)

- **One record per return or exchange** (`return_cases` + lines). Every returned item goes through the one condition-check service (`lib/returns/condition-check.ts`): Good → `EXCHANGE_IN` / `RETURN_IN`, Damaged → `DAMAGE_OUT` + a "Damage / write-off" expense at the line's frozen cost. Completing the check completes the case.
- **Online (by courier):** requested with a reason (required; "Other" needs a note) → approved or rejected by a TL/Manager/Admin (`return.approve` / `exchange.approve`), **never by whoever asked** → waits, with no stock movement, until the item is back and Packing has checked it (the Courier page's condition-check list). SE and TL request on orders in their scope; Accounts can see cases to pay out refunds.
- **At the counter:** no approval. The item is checked on the spot and swapped, and both stock movements happen in one transaction: the replacement is a walk-in order, `COMPLETED` at once, with its stock out as `EXCHANGE_OUT`. It's open from the POS screen (Exchange) and the order page, for users with `pos.sell` + `exchange.create`. Staff find the sale by the **exact order number on the receipt**, whoever sold it. This is the one deliberate reach past list scoping, and it returns only items, prices paid and returnable quantities: no contact details, payments or cost.
- **Money.** Returned units are marked on their line (`returned_qty`, as for partial delivery), and the original total drops by their value (unit price less their share of the line discount). So revenue and COGS leave with the item (§4.12: COGS counts `qty − returned_qty`).
  - **Exchange:** that value moves to the replacement as a pair of `EXCHANGE_CREDIT` payment rows: negative on the original, positive on the replacement. They have no wallet and no TrxID, move no money, and can't be edited. Both count toward `due_amount`.
  - **Replacement price:** the same garment in another size or colour keeps what the customer paid for it, so a plain size swap costs nothing extra. Another product sells at today's price.
  - **Difference:** the customer pays any extra on the replacement like any payment (store credit included). If the replacement is cheaper, the rest is left overpaid on the original and goes back as the case's **settlement** says:
    - **At the counter: always store credit, at once.** No refund waits for approval (the customer has left the shop by then) and no cash leaves the drawer. An anonymous sale needs the customer's phone number first; the number finds or creates the customer (dedupe on phone) and links both orders to them.
    - **Online: staff choose** when requesting — *Refund* (the P2.3 flow, a second person approves) or *Store credit*, credited when the item is back and has passed its check, never before (so a cancelled case never has to claw credit back). The amount is what approval left owed (`owedAmount`), capped at what the order is still overpaid after any refund already paid or pending.
  - **Return:** the original is left overpaid by the returned value; it goes back by refund or store credit, chosen the same way. A fully returned order becomes `REFUNDED` when the refund is approved, or when the store credit is issued.
- **Statuses.** Approving an exchange moves the original to `EXCHANGE_REQUESTED`; its last exchange passing the check moves it to `COMPLETED`. A return of everything the customer had makes the order `RETURNED`; an approved refund on a `RETURNED` order makes it `REFUNDED`. None of these can be picked in the generic status control. The same goes for a customer return (`DELIVERED`/`COMPLETED` → `RETURNED`); a courier return in transit is still a plain move. `EXCHANGE_REQUESTED` can no longer go to `CANCELLED`: the customer has the goods.
- **Replacement orders** carry `exchanged_from_order_id`, and both orders show the link and the reason. An online replacement is `CONFIRMED` with stock reserved and is packed through the normal flow as `EXCHANGE_OUT`. It belongs to the original order's executive, so it stays in their scope. It can't be edited or cancelled on its own; cancelling the exchange handles it.
- **Cancel.** A request can be withdrawn by whoever asked or by an approver. An approved online case can be cancelled by an approver while its item hasn't been checked in and the replacement hasn't gone to the courier. Cancelling cancels the replacement (releasing its reservation, or restocking it if packed), removes the credit, un-marks the returned units, withdraws the check and puts the original back at its old status. Once a return's refund has been approved, it can't be cancelled.
- **Courier charge bearer (online exchanges).** `CUSTOMER`: the replacement is charged the zone's delivery charge. `COMPANY`: it is charged nothing, and the courier's charge for that parcel posts **once** under "Exchange / return cost" (system category *Exchange courier charge*) when the shipment is final. The amount is the actual charge, else the estimate. The courier statement's delivery-charge expense leaves that amount out, so the charge reaches P&L exactly once. If the parcel's payout was already reconciled, nothing is posted.
- **Exchange report** (Returns & Exchanges → Report): by reason, by product and variant, and by the executive who made the sale, with the channel filter. The channel is the **original sale's**: an online order exchanged at the counter counts as Online (it still shows in the counter total). Decided in Verify Phase 3. The courier charge we bore appears only for roles with `product.cost.view`.
- **Store credit** (`store_credit_entries`, `lib/store-credit/`). What the shop owes a customer, to spend later.
  - **A ledger per customer:** every row is *Issued* (from an exchange/return), *Used* (spent on an order), *Given back* (the order it paid for was cancelled, or the use was undone) or *Adjusted*, with its order, return case, user and time. **The balance is always derived from the ledger, never stored**, by one function (`lib/store-credit/balance.ts`).
  - **Through orders only:** every movement except an adjustment is one `STORE_CREDIT` payment row on an order (no wallet, no TrxID, nothing to verify, never edited or deleted — DB CHECKs) plus its ledger row, in one transaction. So the order's `due_amount` and the balance always agree: issuing is a negative row on the overpaid order, spending a positive row on the order it pays for.
  - **Spending:** a payment method at the POS (by the customer's phone number) and on online orders (as the advance at creation, or "Use store credit" on the order), never more than the balance or what's due. The POS and the order form show the balance as soon as a known phone number is typed (the balance only — never the other executive's customer record). Two tills can't spend the same credit: each write locks the customer row.
  - **Cancelled orders** give the credit spent on them back automatically (*Given back*). Credit spent is never refundable as cash; `refundableAmount` also leaves out credit already issued from an order.
  - **Adjustments:** Admin only (`customer.credit.adjust`), reason required (DB CHECK), audit-logged; a deduction can't take the balance below zero. The customer profile shows the balance, what's due to expire, and the whole ledger.
  - **Expiry:** none by default. Settings → *Store credit expires after N days* applies to credit added from then on (each added row keeps its own `expiresAt`). When credit lapses, the soonest-expiring credit is used first, so the customer never loses credit they could have spent; what's left of it at its date has expired. Expiry is derived like the balance — no job writes it.
- **For Phase 4:** a replacement order (`exchanged_from_order_id` set) is not a new sale. Targets, leaderboards and "orders" counts must leave it out, and P&L revenue must use the recomputed order totals.

### 4.12 Expenses & accounting

- Daily expense entry: date, category (ad cost, product purchase, courier, salary, rent, utility, packaging, transport, exchange/return cost, damage / write-off, stock shortage, cash over/short, misc), **fixed vs variable**, amount, wallet paid from, note, attachment.
- **Per-order profit** = selling total − product cost (from `unit_cost_snapshot`) − courier cost − packaging cost − allocated ad cost.
- Ad-cost allocation: daily ad spend spread across that day's confirmed orders (setting: per-order equal split or by order value).
- **Monthly P&L**: revenue, COGS, gross profit, gross margin %, operating expenses by category, net profit, net margin %, month-on-month comparison.
- **The P&L rule (non-negotiable).** `P&L = revenue − COGS − operating expenses`, where
  - **COGS** comes only from the frozen `unit_cost_snapshot` of units actually sold (kept by the customer: `qty − returned_qty`; a returned order has none). Today's purchase price never enters it, and `PURCHASE`-kind expenses (paying a supplier) are cash-out only, never P&L.
  - **Operating expenses** come only from the `expenses` table.
  - **Per-order profit** (which subtracts the order's allocated ad cost and its courier cost) is a separate per-order view. It is **never summed into P&L**, and no report adds per-order courier or ad cost to the expense figures.
  - **Ad spend, courier delivery charges, COD fees and courier return charges each reach P&L exactly once, through expenses**: ad spend as the "Ad cost" expense each daily ad spend row posts; delivery charges and COD fees as the expenses a reconciled courier statement posts; a return charge as the expense the condition check posts — unless that parcel's payout was already reconciled, in which case the statement's delivery-charge expense already carries it and the condition check posts nothing.
  - **Damaged stock** reaches P&L once, as a "Damage / write-off" expense at cost. A damaged return's units left COGS when they came back, so writing them off is not a second charge.
  - **Store credit is a liability, not income or expense (P3.2).** Issuing it is neither: the returned items' value already left the original order's total (and COGS left with them). It becomes revenue only when spent — as part of the total of the order it pays for, which is revenue like any order. Its payment rows carry no wallet, so wallet balances and the collection figures never include it. The collection report shows **Outstanding store credit** (what customers are owed at the end of the period) and the period's issued / used / given back / adjusted / expired amounts on their own lines. For P&L (Phase 4): an Admin adjustment is not a sale — a positive one is a cost (goodwill) and a negative one income, and credit that expires unspent is income (the shop keeps money it no longer owes). Both come only from the store credit ledger, never from `expenses`, so nothing is counted twice.
  - **Packaging used** (P3.3) reaches P&L once per order, as the "Packaging used" expense packing or the counter sale posts at cost; buying packaging is a `PURCHASE` (cash-out only), never P&L.
  - **Unexplained stock loss** reaches P&L through "Stock shortage": every manual stock-count adjustment posts there at cost — a shortfall as a cost, stock found later as a credit — so the heading shows the net loss. Damage and unexplained loss are different problems and are never mixed.
- Wallet running balances and a cash-position view.
- **Admin/Manager only.** Not visible to SE, TL, Packing.

#### Decisions made during build (P2.3 — wallets, verification, refunds, expenses)

Covers §4.10 and §4.12. Recorded so P&L (Phase 4) and returns/exchanges (P3) build on the same rules.

- **Wallets store no balance.** A balance is always derived (`lib/wallets/ledger.ts`): opening balance + **verified** payments into it − **approved** refunds out of it − expenses paid from it ± manual entries/transfers + courier payouts (statement **net**, once `PAID`) into it. Only money dated on/after the wallet's opening date counts. Unverified payments show as "pending" next to the balance, not in it. Wallets are deactivated, never deleted.
- **No money dated in the future** (Verify Phase 2). Payment/refund dates, expense and ad-spend dates, wallet entries/transfers and manual courier statement dates must be today (Dhaka) or earlier. A future-dated row would sit in the balance before it happened, and the balance would stop matching the statement's closing figure.
- **A courier payout's net lands in its wallet once the courier has paid, even while a line is disputed.** The wallet mirrors the real bank account. A mismatch moves no *order* money: no payment, no change to `due_amount` or status, no charge expenses, until Accounts accepts the line.
- **Default wallets** (bKash Personal, bKash Merchant, Nagad, Rocket, Bank Account, Showroom Cash) are created by the migration with opening balance 0 dated 1 Jan 2026. **Set the real opening balances before go-live** (SETUP.md).
- **Which wallet a payment lands in** is checked against its method (bKash → a bKash wallet, card → bank, cash → cash). With none picked, the first active matching wallet is used. The old free-text `wallet` values were migrated to wallet links (unmatched text kept in the payment's note).
- **Courier COD carries no wallet** (DB CHECK). That money reaches the bank as the courier statement's net payout, so courier charges the courier deducted are expenses with no wallet either. The P2.2b payout wallet (`courier_statements.wallet`, free text) is now `walletId`; new statements default to the first active bank wallet.
- **Verification.** Accounts verifies from a queue (oldest first, bulk). Each verification is audited with who and when. Editing the amount, method, wallet or TrxID of a verified payment sends it back to the queue.
- **Refunds** are `payments` rows with `kind = REFUND` and a negative amount (DB CHECK), a required reason, and a `PENDING → APPROVED/REJECTED` decision by someone holding `payment.refund_approve` (Admin, Manager) **who didn't request it**. Only an approved refund counts toward `due_amount` and the wallet. A refund can't exceed verified money received less other pending/approved refunds. Refunds are never edited or deleted — rejected and re-requested. Order status is untouched (P3 returns move it to `REFUNDED`).
- **Expense categories map to the §4.12 headings** (`expense_categories.kind`). System categories — Ad cost, courier delivery/COD/return charges, Damage / write-off, Stock shortage — are posted by the app and can't be picked on the expense form, so nothing is entered twice. A system-posted expense is changed at its source, never on the expense screen.
- **Damage / write-off is its own heading** (`DAMAGE_WRITE_OFF`), not Misc, so the owner sees monthly damage losses. Every `DAMAGE_OUT` — a manual write-off or a damaged return from the condition check — posts one expense there at cost. Existing write-off expenses were moved to it (migration `20260924090100`).
- **Stock shortage is its own heading** (`STOCK_SHORTAGE`), apart from damage. Every manual adjustment (`ADJUSTMENT`, reason required, Admin/Manager) posts one expense there, valued at the variant's weighted average cost at that moment, with no wallet: a shortfall as a positive cost, stock found as a **negative** credit. The heading's monthly total is the net unexplained loss. Only these stock-posted rows may be negative (DB CHECK `expenses_amount_sign_chk`); a zero-cost movement posts nothing. Adjustments already in the ledger were backfilled (migration `20260924140100`). Opening-balance ledger rows are not adjustments and post nothing.
- **Daily ad spend** (`daily_ad_spend`) is the only way to enter ad cost. Each row posts exactly one "Ad cost" expense from its wallet (edited/deleted with it).
- **Ad-cost allocation** (setting `ad_cost_allocation`: `EQUAL` default, or `BY_VALUE`; changed by Admin) spreads a day's spend over the orders **first confirmed that Dhaka day**, excluding deleted and cancelled orders. Only `ONLINE` orders count: POS sales never pass through CONFIRMED, so they carry none. An exchange replacement (`exchanged_from_order_id` set) is the same sale going out again, not a new one an ad brought in, so it carries none either (Verify Phase 3). It's derived on demand (`lib/expenses/ad-allocation.ts`), not stored, and splits in whole paisa that add back to the day's spend. A day with spend but no confirmed orders stays unallocated. It still counts as an expense.
- **P&L must not double count** — see *The P&L rule* above. Operating expenses come from `expenses`. `PURCHASE`-kind expenses (paying a supplier) are cash-out only: stock cost reaches P&L as COGS through `unit_cost_snapshot`, so P&L must leave them out.
- **Receipts** (one per expense, image or PDF) live under `uploads/expenses/<id>/` and are served only to `expense.view`.
- **Who sees what.** Wallets, expenses, ad spend, refunds and both reports are Admin/Manager/Accounts only (`wallet.*`, `expense.*`, `payment.*`). Accounts can request refunds and record wallet entries but not approve refunds or add wallets / change opening balances.

### 4.13 Targets, rewards, leaderboard

- Monthly target per SE and per team: order count and/or order value.
- Live progress gauge on the SE dashboard ("Tk 1,42,000 of Tk 2,00,000 — 71%, 9 days left").
- Reward rules table: threshold → reward (amount or note), auto-evaluated at month end.
- Leaderboard: this month's top SEs by value and by converted orders, with delivered-vs-returned quality shown alongside (so quantity alone can't win).

#### Decisions made during build (P4.2 — targets, rewards, leaderboard)

- **Months are Dhaka calendar months** (`"YYYY-MM"`). A target (`targets`) is for one person *or* one team and sets an order count, an order value, or both (DB CHECKs). Individual targets are for the sales floor — Sales Executives and Team Leaders (`lib/auth/rosters.ts`). Set, change, remove and "copy last month's" need `target.manage` (Admin/Manager) and are audit-logged. A month's targets are **final once its rewards are worked out**.
- **What counts** (`lib/targets/performance.ts`, never stored — progress is always live): orders **placed** in the month (Dhaka time) by the person (a team's: orders carrying its `teamId`), not deleted, not `LEAD`/`CANCELLED`, and **not an exchange's replacement order** (P3.2). Value is the order total, which already drops by anything returned. Fully returned orders (`RETURNED`/`REFUNDED`) count toward neither value nor order count; they show under quality.
- **Quality** = delivered ÷ (delivered + returned) for the month's orders, with the counts (delivered · returned · on the way) beside it everywhere a number appears. Delivered = `DELIVERED`, `COMPLETED`, `PARTIAL_DELIVERED`, `EXCHANGE_REQUESTED`. Under 80% the row is flagged with an icon.
- **Leaderboard** ranks the whole sales floor by *Order value*, *Delivered value* (only what reached the customer — the measure returns can't inflate) or *Orders*; ties go to the better delivered rate. Scope follows `target.view_*`: an **executive sees only their own row and their rank** ("#2 of 4") — never another executive's numbers; a TL their team (with shop-wide ranks) and the team table; Admin/Manager everyone.
- **Gauge**: the dashboard's "My target this month" card and the Targets page — a half-ring for value (count if there's no value target), "৳ X of ৳ Y — N%, D days left" (today included), what's needed per day, a count bar when both are set, and the quality line.
- **Reward rules** (`reward_rules`): each person or each team; measure = % of value target, % of count target, order value, delivered value, or orders; threshold → an amount, a note, or both; optional **delivered floor** (1–100%). **Rules on the same scope + measure are tiers — only the highest reached pays**; different measures add up. A % rule needs that target. Rules are switched off, never deleted.
- **Month end**: `GET /api/cron/rewards` (CRON_SECRET, daily) works out last month the first time it runs in a new month; `target.manage` can work a closed month out again by hand, which replaces its awards. Awards (`reward_awards`) copy the rule and the month's numbers, so editing a rule never changes a past month. Both are audit-logged (`reward.evaluate`). The current month shows a live "if it ended today" preview. Payout is outside the system (payroll is out of scope).

### 4.14 Attendance & leave

- Check-in / check-out with time; late / absent / half-day / leave flags driven by office-hour settings.
- Leave request → TL/Admin approval → reflected in the attendance sheet.
- Monthly attendance report per staff member.

#### Decisions made during build (P4.2 — attendance and leave)

- **Roster**: every active user except the owner (Admin) (`lib/auth/rosters.ts`). Scope follows `attendance.view_all / _team / _own` (`lib/auth/permissions.ts viewLevel` + `levelScopedWhere`), not the role default — Packing and Accounts see only their own.
- **Check-in / check-out**: one tap each for oneself (`attendance.mark`), stamped with the **server's** clock and the IP; one row per person per Dhaka day. Nobody checks in for someone else.
- **Office hours** (Settings → *Office hours & late rule*, one JSON setting, audit-logged): opening/closing time, late grace (default 15 min), half-day cut-off (default 120 min after opening), half day if fewer than N hours worked (default 4), weekly off days (default Friday), holiday dates. Defaults 10 am – 8 pm.
- **Flags**: *Late* = checked in past the grace; late minutes count from opening time. *Half day* = checked in at/after the cut-off, or checked out with too few hours. Coming in on an off day or holiday is just *Present*. The status is **worked out when the day is recorded and kept**, so changing office hours never rewrites history.
- **Derived marks** on the sheet (`lib/attendance/days.ts`): no check-in + approved leave on a working day → *Leave*; weekly off / holiday → shown as such; otherwise a working day that's over (past, or today after closing) → *Absent*. Days before the person's join date, and future days, are blank. Totals count days so far; a day with a check-in but no check-out is flagged.
- **Corrections**: `attendance.manage` (Admin/Manager) sets a day's times with a required reason (DB CHECK) — creating the day if missing; the status is recomputed and the change audit-logged.
- **Leave**: anyone on the roster asks for their own (casual, sick, annual, unpaid, other), from 30 days back to a year ahead, at most 60 days, never overlapping their pending/approved leave. **`leave.approve`** (new: TL, Manager, Admin) decides — a TL only their team's, **never one's own**; a rejection needs a reason. The person can cancel while it's pending or before it starts; an approver can cancel approved leave. Every decision/cancel is audit-logged. Weekly offs and holidays inside the dates don't use leave.
- **Monthly report** (Attendance → Monthly report): summary per staff member (working days, present, late, half day, absent, leave, no check-out) and the day-by-day sheet; CSV needs `report.export`. R10 in P4.4 builds on this.

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

#### Decisions made during build (P4.4 — reports, P&L, audit log)

- **One engine, one result.** Every report (R1–R14, and the P&L as R9) is built by `runReport()` (`lib/reports/run.ts`) into one shape: figures, tables, notes. The screen (`/reports/<key>`), the JSON route (`GET /api/reports/<key>`) and both exports (`GET /api/reports/<key>/export?format=csv|pdf`) all call it with the same filters. So an export can't hold anything the screen doesn't. Filters are Zod-parsed from the query string. Ranges are inclusive Dhaka days, at most two years, defaulting to this month (the P&L and the expense report default to the last six months). An invalid filter is a 400 from the API. On the page it falls back to the default.
- **Who runs what.** Every report needs `report.view` plus the permission of the module its numbers come from (`lib/reports/access.ts`): sales / channel / cancelled & returned need `order.view_*`, leads `lead.view_*`, team performance `target.view_*`, stock `inventory.view`, sets `product.view`, courier `courier.view` or `courier.reconcile`, collection `payment.view`, expense `expense.view`, attendance `attendance.view_*`, customer `customer.view_*` + `order.view_*`, exchange `exchange.view`, P&L `report.pl.view` + `product.cost.view` (Admin, Manager). **Sales Executives now hold `report.view`** (seed template), so "an SE's report shows only their own data" is reachable. They get no export (`report.export` stays Admin/Manager). Packing and the POS till hold no `report.view`.
- **Scope.** Order-, lead-, customer-, courier-, collection- and exchange-based reports go through the shared role scope (`scopedWhere`): an SE sees their own, a TL their team. Team performance and attendance use the P4.2 view levels (`target.view_*`, `attendance.view_*`). The person / team filters only narrow inside that scope. An SE naming another executive's id gets an empty report. The person dropdown lists only people in scope, and is hidden for someone who sees only themself.
- **Cost columns** are flagged in the report definition and removed server-side, both the column and every value, for anyone without `product.cost.view` (`lib/reports/finalize.ts`). `stripCostFields` then runs over the whole result as a second net. Cost data covered: stock unit cost and value at cost, channel cost of goods / gross profit / margin, courier charges, and the cost the shop bore on exchanges. Notes that explain cost are left out too.
- **What counts as a sale** in R1, R3, R12, R14 is the targets / dashboard rule: placed in the period, not LEAD / CANCELLED / RETURNED / REFUNDED, not deleted, not an exchange's replacement. R1's Orders and value equal the order list's *Counted as sales* slice for the same user, dates and channel. The Orders figure and the period, channel and person rows open that list. A status filter replaces the rule ("orders placed in the period now in this status"). With a category filter, orders and value are for orders containing that category, and the category table counts item value after line discounts for units kept. That excludes delivery charges and order discounts, so it sums to less than order value. Group-by is automatic (days ≤ 45 days, weeks ≤ ~6 months, months beyond) or chosen. Weeks run Saturday–Friday.
- **R3 Team performance**: per person on the sales floor. Leads = recorded + daily counts created in the period. Conversion = converted ÷ leads. Delivered rate = delivered ÷ (delivered + returned). Exchanged = exchanges approved in the period on their orders. Targets are monthly: a range adds up the targets of every month it touches, so a part-month compares part of a month's sales with the whole month's target (stated on the report).
- **R4 Stock** is a snapshot of now, plus the period's stock movements per variant: in, out, and sold (packed online + counter sales). **R5** is availability now plus sets sold in the period (on the user's visible orders).
- **R6 Courier**: parcels handed over in the period, followed to where they are now. Delivered includes partial, and the percentages are of parcels with an outcome. Average days = hand-over → delivered. Charges are per parcel (actual, else estimate). They reach the P&L only through statement expenses.
- **R7 Collection**: money in by day / method (the P2.3 collection report), beside each day's sales and what is still due on them. Ageing is as of now: all money due on sales by days since placed, and COD the courier hasn't paid out by days since delivery (the COD tab's parcels).
- **R11 Cancelled & returned**: cancellations in the period (reason = the note written when cancelling) at order total, plus items that came back in the period (courier return, refused part of a partial delivery, customer return with its reason) at the price paid. Exchanges are R13's, since the sale is kept.
- **R12 Customer**: top 50 by value. Repeat rate = customers who bought twice in the period, or had bought before it, ÷ customers who bought. Risk-flagged = tagged *Problem customer*, or 3+ parcels the courier brought back (the §4.4 refused-COD rule), all time. Anonymous walk-in sales are counted separately.
- **R9 P&L** (`lib/reports/builders/pl.ts`) runs month by month on the P4.3 profit rule (`lib/finance/profit.ts`). Revenue and COGS count on the day goods leave (first PACKED, or a walk-in sale's moment). COGS = `unit_cost_snapshot` × units kept, never today's cost (tested: changing `weightedAvgCost` afterwards doesn't move it). Operating expenses = every heading but Product purchase. The P&L now also takes the §4.12 store-credit lines from the store-credit ledger: expired credit is income, and a net Admin adjustment is a cost (added) or income (taken). Net = gross − operating expenses + store-credit income. It shows a statement for the period, a month-on-month table (gross and net margin, change in net profit against the month before) and operating expenses by heading per month. Each month opens the P4.3 profit breakdown.
- **Exports**: CSV is UTF-8 with a BOM (Bangla opens in Excel). Numbers stay numeric (money in taka to 2 decimals, percents as 12.5). Text cells that would run as a spreadsheet formula are escaped. The PDF is A4, landscape when a table is wide, with the embedded Bangla font, period, filters and generation time in the header.
- **Audit log** (`/audit-log`, `GET /api/audit-logs`, `audit.view` = Admin only): newest first, 50 a page. Filter by person, record type, record id, "action contains" and Dhaka dates. Each row shows who, action, record (linked for orders, customers, products and leads), time, IP, the top-level fields that changed, and the before/after JSON.

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

#### Decisions made during build (P4.3 — dashboards)

- **Which dashboard is picked by permission, never by role name** (`lib/dashboard/panels.ts`). Owner view = `report.pl.view` + `product.cost.view` + `order.view_all` (Admin, Manager). Sales view = own/team lead or target visibility (SE, TL). Packing = `packing.view_queue`, Accounts = `payment.view`. Someone who holds both gets both. The owner's view already includes the queue, payments and alerts, so Admin/Manager see only that. POS has no PRD dashboard, so the till gets one tile: "My sales today". Anyone on the attendance roster also gets the check-in card.
- **Every number opens the list it summarises, computed with the same filter.** The order list gained named slices (`lib/orders/list-presets.ts`, `?preset=`). *sales* = the target definition (not LEAD/CANCELLED/RETURNED/REFUNDED, not an exchange replacement). *due* = sales with money owed. *in_transit* = handed to courier + in transit. *stuck* = see below. It also gained `?dateBy=placed|packed|delivered`. The list footer shows the matching count, total value and due, so a tile can be checked against it. Order-list `from`/`to` are now **inclusive Dhaka days** (they were UTC instants, which cut off a day's last 6 hours). Packing got views (`?view=queue|overdue|ready|packed_today`, still money-free). Expenses, payments, the collection report, courier (`?tab=cod`) and returns (`?view=requested&type=`) now accept their filters from the URL.
- **Today / MTD row.** Orders and value are *sales* placed in the period, so month-to-date equals what targets count. Due = still unpaid on those orders. Collected = the collection report's "Collected" (money received, `kind = PAYMENT`). Expenses = operating expenses, i.e. every heading except *Product purchase* (the expense list's "All but supplier payments" filter). **Target progress** adds up team value targets when any team has one, otherwise individual ones.
- **Profit (owner only)** follows the §4.12 P&L rule (`lib/finance/profit.ts`). Revenue and COGS are counted **on the day the goods leave**: the first PACKED move, when `unit_cost_snapshot` freezes, or the moment a walk-in sale is rung up. Revenue = order total (already net of returned items). COGS = snapshot × units kept. Then subtract operating expenses dated in the period. Confirmed-but-unpacked orders carry no profit yet. Cancelled and fully returned orders carry none at all. Store-credit adjustments and expiries are left to the full P&L (P4.4). The Profit tile opens **Reports → Profit breakdown** (`/reports/profit`, same gate): the orders that went out with revenue, cost and gross, plus expenses by heading.
- **Operations funnel** shows live counts: open leads → CONFIRMED → PACKED → with the courier → *delivered today* (a DELIVERED / PARTIAL_DELIVERED move today).
- **30-day charts** (Recharts, today included). *Sales trend*: daily sales value stacked online/walk-in; a bar opens that day's orders. *Channel split*: the same 30 days as a donut. *Profit trend*: daily profit, losses in red; a bar opens that day's breakdown. *Returns & exchanges*: per day, customer returns + parcels the courier brought back, and exchanges opened (rejected/cancelled cases excluded). The rate = those ÷ (orders that reached a customer + courier returns). Every chart has a "Show as a table" view with links. Colours are the validated dataviz palette tokens `--viz-*` in `globals.css`, with separate light and dark steps.
- **Alerts**: low stock (variants, from the low-stock screen); overdue follow-ups; unverified payments; **COD not received after 7 days** (`COD_OVERDUE_DAYS`, delivered and not yet paid out); **orders stuck** in one status past its limit. The limits are LEAD 3 days, CONFIRMED the packing SLA, PACKED 24 h, handed to courier 3 days, in transit 7 days, on hold 3 days, partially delivered / exchange requested 7 days (`STUCK_AFTER_HOURS`). "Stuck" = no status change since the cutoff, using `order_status_history`.
- **SE / TL.** Tiles: this-month value, today, open leads, on-hold orders. Also leads by stage, follow-ups due today, orders by status (in progress = any date; delivered/completed/cancelled/returned/refunded = placed this month) and the target gauge. The TL sees team versions: team gauge, a per-member table and team-scoped counts, all through the shared scope helper. They also see **pending approvals**: order edits, returns, exchanges and (P4.2) leave. Each count matches the screen it opens.
- **Date filter (CORRECTIONS.md item 16, C2).** The dashboard has the shared date filter, default This Month. Period figures follow it: the owner's second row (was MTD), channel split, the SE/TL value tile and "placed in the period" statuses, the Accounts collection and expenses (were today's), and the till's sales. The owner's Today row, the live funnel, queues, alerts and the monthly target strip don't; the target strip shows only on This Month. The daily charts cover the period, widened to 30 days when it's shorter than a week and trimmed to its last 92 days when longer.
- **iOS**: Recharts' bundled es-toolkit calls `structuredClone` (only to copy an Error). `lib/browser/polyfills.ts` now fills it for Errors and plain data, and `check:ios` treats it as polyfilled.
- **Verify Phase 4 fixes.** *COD not received after 7 days* now opens the COD tab on just those parcels (`/courier?tab=cod&overdue=1`, an "Over 7 days only" toggle). Before, it opened every parcel awaiting payout. The overdue follow-up counts are counts of reminders, and a lead can have several, so they now open **Leads → Follow-ups**, whose Overdue / Later today sections show the same numbers. The Leads list's follow-up filter counts leads. Order numbers (`AB-YYMM-…`) take the **Dhaka** month: a UTC server had put an order placed at 00:30 on the 1st into last month's sequence. `lib/reports/__tests__/phase4-verify.integration.test.ts` holds the proofs: the P&L recomputed from the raw rows in SQL, each expense source posted once, store credit, Dhaka day and month edges, dashboards against their lists, the channel split, and cancelled or returned orders dropping out of targets.

### 4.17 Settings (Admin only)

Business profile (name, logo, address, phone, invoice footer) · Stock locations, the packing hub, the POS showroom and each location's managers (C3) · Store credit expiry (optional, off by default — P3.2) · Size master · Colour master · Category master · Courier companies and zone charges · Payment methods and wallets · Order edit-window minutes · Low-stock default threshold · Office hours and late rule · Ad-cost allocation method · Target and reward rules · Roles and permissions · Users · Steadfast API credentials and webhook URL · Backup status.

#### Decisions made during build (P5.2 — settings and go-live data)

- **One Settings screen, one section at a time** (`/settings?section=…`, `settings.manage`): Business profile · Catalog masters · Couriers & zones · Steadfast · Payments & wallets · Orders, stock & hours · Targets & rewards · Users & teams · Roles & permissions · Import opening data · Backups & jobs. Masters, Steadfast, wallets, office hours, store credit, reward rules and backup status reuse the components their modules already had, so each rule lives in one place. Users & teams also needs `user.view`, Roles & permissions `permission.manage`; every API route checks its own permission.
- **Business profile** (setting `business_profile`, JSON): name, tagline, address, phone, email, invoice footer, logo. The logo is one PNG under `uploads/branding/` (≤ 600×300), inlined into the PDFs. The invoice prints the full block; the packing slip the logo, name and tagline; the 80 mm receipt a greyscale logo, name, tagline, address and phone, and the footer. Invoices already generated are files and keep what they printed.
- **Couriers & zones**: name, contact, active, and per zone the customer's delivery charge, COD % and return charge (audited before/after). Couriers are switched off, never deleted. What *we* pay the courier stays the cost-rate table on the Steadfast section (cost data).
- **Payment methods** (setting `payment_methods_enabled`): which of bKash / Nagad / Rocket / Bank / Cash / Card staff can pick (at least one). A switched-off method disappears from the order form, the payments panel, the POS and the counter exchange, and the server refuses **new** money by it (`assertPaymentMethodEnabled`). A payment already recorded keeps its method, and refunds are not checked. Courier COD, exchange credit and store credit are the system's and never switched.
- **Orders, stock & hours**: order edit window (minutes), packing SLA (hours) and the **low-stock default** (setting `low_stock_default`). Every stock query reads the default inside its SQL (`LOW_STOCK_DEFAULT_SQL`), so the stock report, low-stock screen and alert, product badges, dashboards and reports all agree with Settings; 5 when unset.
- **Users** (PRD §4.1): name, phone (sign-in, normalised to 01…), optional email, role, team, join date, active. A new account and a reset get a temporary password and must change it at first sign-in; a reset also clears a lock-out. People are deactivated, never deleted (signed out on their next request). Teams: name, leader, active; making someone leader moves them into the team (a Team Leader's scope is their own team), and a team with active members can't be switched off.
- **Two guards on every people/permission change**, worked out from permissions, never role names (`lib/settings/staff.ts`, `lib/auth/permissions.ts`): **no escalation** — without `permission.manage` you can only create, edit, reset or deactivate someone, or hand out a role, whose permissions are all your own (so a Manager with `user.edit` can't reset the owner's password or make anyone Admin; deactivating also needs `user.delete`); **no lock-out** — a change that would leave no active person holding both `settings.manage` and `permission.manage` is refused, as is deactivating yourself.
- **Roles & permissions**: each role's template is edited in the database, which is what every request reads, one role at a time with a *starting template* reset. Per-person overrides (grant / take away, with a reason) sit on each person. All audited (`role.permissions_update`, `user.permission_overrides`). **The seed no longer resets role permissions**: a role gets its full template only when the seed creates it; an existing role only gains template keys for permissions that run added (`SEED_RESET_ROLE_PERMISSIONS=1` restores every template — dev only). The seed also stops overwriting courier zone charges.
- **Go-live database**: `npm run db:seed:base` seeds only permissions and roles, the size/colour/category masters, the Steadfast courier, wallets, default settings and the first Admin (`SEED_ADMIN_NAME`, `SEED_ADMIN_PHONE`, `SEED_ADMIN_PASSWORD`, optional `SEED_ADMIN_EMAIL`; must change the password at first sign-in). No demo people, customers, stock or money.
- **Import opening data** (Settings → Import, `lib/import/*`): CSV (UTF-8, Excel's BOM, quoted commas and line breaks; Bangla digits, ৳ and lakh commas in numbers; dates YYYY-MM-DD or day-first DD/MM/YYYY, never month-first; lists inside a cell separated by `;`). Each sheet has a downloadable template. **Check** plans the whole sheet and lists every problem by row; **Import** plans it again inside one transaction and writes only if nothing is wrong — all or nothing, audited. Needs `settings.manage` plus: products `product.create` + `product.cost.view`; customers `customer.create`; wallets `wallet.manage`.
  - **Products**: one row per size/colour; rows with the same code (or, without one, the same name) are one product, and product-level cells must agree. Size, colour and category must already be in the masters (matched by name or code, case-insensitive) — never created from a typo. A new product without a code gets the first suggested code whose SKUs are free; a typed SKU or code that clashes is an error. **Opening stock** = one `ADJUSTMENT` / `OPENING_BALANCE` ledger row at the sheet's unit cost (required with a quantity), at the row's `location` (blank = the packing hub; C3 — a size/colour may repeat on another row for a second location), written with the stock change; that cost becomes the variant's weighted average cost; no expense. A variant with any stock history can't take an opening balance (use a purchase or adjustment). An existing product keeps its details and only gains new sizes/colours and opening stock.
  - **Customers**: one person per phone. A phone already in the system (trash included) is skipped, never overwritten, so a fixed sheet can be re-run. `owner_phone` makes a staff member the owner (their team copied), which is what lets a Sales Executive see their existing customers; blank = the importer.
  - **Wallets**: a name matching a wallet updates its opening balance, date, type (only if it has no payments) and account through the same audited service as the Wallets screen; a new name adds a wallet. Opening dates can't be in the future.

### 4.18 System-wide behaviour

- **Audit log** on every sensitive mutation, with a viewer (Admin only), filterable by user/entity/date.
- **Soft delete + Trash**: deleted orders/customers/products go to trash, restorable for 30 days, then purged by a nightly cron.
- **Nightly `pg_dump` backup** — non-negotiable. Backup status visible in Settings; alert if the last backup is older than 48 hours.
- **Bangla support**: Bangla text renders correctly everywhere including PDFs (embedded Bangla font in the invoice/packing slip).
- **Mobile-first**: SE, Packing and POS screens must be fully usable on a phone; installable as a PWA.
- **One pagination everywhere (CORRECTIONS.md item 15, C2).** Every list pages server-side at **25 / 50 / 100** per page with "Showing X–Y of Z" (`components/list/list-pagination.tsx`). The size each person picks is remembered per list in `user_list_preferences`, across devices. Report tables page on screen; exports carry every row.
- **One date filter everywhere (item 16, C2).** Today · Yesterday · Last 7 days · This Month · Last Month · All Time · Custom range, in Dhaka days (`lib/date-range.ts`, `components/list/date-range-filter.tsx`). It is on the dashboard, every report and every dated list. Lists that had no default keep showing everything (All Time); reports keep their default period. Where a screen needs both ends (reports, P&L, wallet statement), All Time starts at the first order or expense (reports) or 2020-01-01. Reports still cap a chosen range at two years, and All Time is trimmed to its last two years.

---

## 5. Data model (table groups)

**AUTH & ORG** — `users`, `teams`, `roles`, `permissions`, `role_permissions`, `user_permission_overrides`, `sessions`, `audit_logs`

**LEADS** — `leads`, `lead_followups`, `lead_daily_counts`

**CATALOG & STOCK** — `categories`, `products`, `product_images`, `product_variants`, `sizes`, `colors`, `outfit_sets`, `outfit_set_items`, `suppliers`, `purchases`, `purchase_items`, `stock_movements`, `locations`, `variant_stocks`, `user_locations` (C3), `stock_transfers`, `stock_transfer_lines`, `stock_transfer_orders`, `stock_counts`, `stock_count_lines`, `document_sequences` (C4), `shelves`, `shelf_stocks`, `shelf_misses`, `shelf_movements`, `shelf_counts`, `shelf_count_lines` (C4b)

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
2. A stock change and its `stock_movements` row are written **in the same transaction**. No exceptions. Stock is held per location (C3): **for each variant at each location, stock = the sum of that location's ledger rows**, and a variant's total stock is the sum of its locations + in transit (C4: transfer rows with no location; `inTransitQty` = their sum). The database refuses any commit that breaks any of these. Shelves (C4b) sit inside that: a shelf never holds less than zero, a location's shelves never hold more than its stock, and *Unassigned* is derived (stock − shelves), never stored; stock leaving a location leaves its shelves in the same transaction.
3. `unit_cost_snapshot` is frozen on the order item **at `PACKED`** and never changes afterwards — historical profit must not move when today's purchase price changes.
4. `payments.transaction_id` is **globally unique** (where not null).
5. Cost, profit, margin and purchase price are **stripped server-side** for roles without `product.cost.view`.
6. List queries are **scoped server-side** by role (SE → own, TL → team). The client cannot widen the scope.
7. Selling below available stock is blocked on the **online order form** (and edits), except by an Admin/Manager override that records a reason — until C5, when online orders may be taken with no stock and those lines become backorders (CORRECTIONS "Changes to existing rules" 2). **At the POS** (C3), an item the showroom shows as 0 may be sold after the operator confirms it is in hand: that location goes negative and appears on the Negative stock alert for its manager.
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
