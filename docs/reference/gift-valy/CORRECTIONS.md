# Gift Valy — Corrections List

> Tags: [BUG] ভাঙা · [CHANGE] আচরণ বদলাতে হবে · [UI] দেখতে/সাজাতে · [FIXED] হয়ে গেছে
> Build order: নিচের "BUILD ORDER" section-এর prompt গুলো serial অনুযায়ী দিন — প্রতি prompt-এর পর test, তারপর `/clear` দিয়ে পরেরটা।

---

## BUILD ORDER — Correction Round 1 (Prompts C1–C10)

### Prompt C1 — Catalog Foundation (সবার আগে — বাকি সব এর উপর দাঁড়াবে)
```
Read CORRECTIONS.md → "Products & Packages" items 1–5. Implement all five:
component-only products, product-level packing materials, weight + 3-zone
delivery charge fields, BOM quantity verification, and nested packages with
choice/variant groups. Migrations + seed updates included. Write unit tests
for the recursive BOM explosion (cost, weight, stock deduction, availability,
cycle prevention). Mark the items [FIXED] in CORRECTIONS.md, commit, and tell
me how to test in the browser.
```

### Prompt C2 — Order Form & Lifecycle Core
```
Read CORRECTIONS.md → "Leads" items 9–10 and "Orders" items 1, 4, 5, 6d, 7
(schema + form parts). Implement: Committed lead status + queue, DRAFT order
stage with Pending-Payment tab and DRAFT-XXXX numbering, requested delivery
date with ASAP/Any day/Fixed modes, "Special One ❤" relation, remove
District/Thana fields (full address only, free delivery default, zone
selector per Products item 3), the 3-note system (Order/Invoice/Courier notes
on the form + list modal + invoice print + Steadfast note field), and
recipient Birthday/Anniversary fields saved to the customer profile.
Run npm run verify:lifecycle after. Mark items [FIXED], commit.
```

### Prompt C3 — Order List UI
```
Read CORRECTIONS.md → "Orders" items 6a, 6b, 6c, 6e, 6f, 6g, 6h, 6i.
Implement: customer column (Name→Phone→Country), recipient phone under name,
Items column with +N more chips, Action column (view/edit/trash), Trash tab
with 30-day auto-delete + restore + reserve release, inline single & bulk
status change (eligible statuses only, all side effects preserved), bulk
invoice print from CONFIRMED and PACKED tabs, and the half-A4 two-up invoice
redesign. Mark items [FIXED], commit, tell me how to test.
```

### Prompt C4 — Leads Page Overhaul
```
Read CORRECTIONS.md → "Leads" items 1–8. Implement: WhatsApp-number-first
form order, country auto-detect from country code (default KSA, editable),
form defaults (Status New / Country KSA / Source WhatsApp / follow-up =
entry date + 1 day), list default filter This Month + pagination (25/50/100),
notice-style redesign of the follow-up/overdue indicators, Orders-style page
restructure (list landing + New Lead button, Bulk Lead button only with
permission), assign-on-entry field for users with assign permission, and
verify total lead counts everywhere = individual + bulk combined.
Mark items [FIXED], commit.
```

### Prompt C5 — Courier Menu + Steadfast Send/Columns
```
Read CORRECTIONS.md → "Courier / Shipments" items 1–2 and "Orders" items
6j, 6k, 6l. Implement: 3-zone + weight courier cost estimation (actual
delivery_charge from webhook overrides), Steadfast-only Courier page (move
integration UI from Settings, add zone rate config, remove Courier
companies/Returns/Shipments submenus, keep schema multi-courier),
send-to-Steadfast from CONFIRMED tab (auto-apply PACKED transition), Handed
to Courier columns (Consignment ID + Tracking Link), In Transit columns
(+ Steadfast Delivery Charge + Weight with tracking-page scraping fallback
+ tracking link discovery from raw API response logging).
Mark items [FIXED], commit.
```

### Prompt C6 — In Transit & Returned Tab Restructure
```
Read CORRECTIONS.md → "Orders" items 6m and 6n. Implement: In Transit
auto-entry on warehouse receive, Courier Status column (Pending / Assigned /
Delivery Approval Pending / Return Approval Pending), Rider Info column
(tracking-page parsing), 4 count-badged sub-tabs, auto-move to Delivered /
Returned on final approval; Returned tab Pending/Received sub-tabs with the
receive-time damage inspection dialog (OK → stock IN_RETURN, Damaged →
damage log + P&L loss + damaged-stock report, no admin approval step).
Run npm run verify:lifecycle. Mark items [FIXED], commit.
```

### Prompt C7 — Delivery Schedule + Requirement Planner
```
Read CORRECTIONS.md → "Orders" items 2–3 and "Stock / Purchase" item 1.
Implement: Delivery Schedule view (Today/Tomorrow/Next 7 days/This Month/
Next Month/Custom, date-grouped, ASAP in Today, fixed-date badges), late-risk
red flags + dashboard count, and the Delivery Requirement Planner (BOM-exploded
required vs stock vs shortage, unit cost × shortage, grand total, one-click
purchase requisition, DRAFT toggle, no double-counting with reserves).
Mark items [FIXED], commit.
```

### Prompt C8 — Occasions Menu & Reminders
```
Read CORRECTIONS.md → "Orders" item 7 (menu + reminder parts). Implement:
the Occasions menu (Today/Tomorrow/Next 7 days/This Month/Custom filters,
customer + recipient + relation + occasion + days-remaining + last order +
Follow up action), customer-profile occasion editing, and the
configurable-lead-time reminders surfacing in the SE follow-up area.
Mark item [FIXED], commit.
```

### Prompt C9 — Dashboard Widgets
```
Read CORRECTIONS.md → "Dashboard" items 1–7. Add the widgets (Leads count,
Orders count, Delivered count+amount, Advance Collection, Total Collection
with Advance/COD/Post-delivery-MFS breakdown, Courier Balance via
/get_balance, Draft Orders count+amount linking to the Pending Payment tab).
All must follow the global date-range switch. Keep every existing widget.
Mark items [FIXED], commit.
```

### Prompt C10 — Round 1 Verification
```
Verification pass for correction round 1. With seeded demo data:
1. Full new lifecycle: lead → Committed → DRAFT → payment → CONFIRMED →
   send to Steadfast from CONFIRMED (mock API) → In Transit (mock webhook
   pending) → rider assigned (mock) → Delivery Approval Pending → Delivered;
   verify COD reconciliation still works
2. Return path: In Transit → Return Approval Pending → Returned Pending →
   Received with 1 item damaged → stock restored correctly, damage logged,
   P&L shows the loss
3. Nested package (combo with a choice group) order: stock deduction,
   cost snapshot, availability all correct; npm run verify:lifecycle passes
4. Trash → restore → reserves correct; trash 30-day cleanup job dry-run
5. Login as Sales Executive: STILL no cost/profit fields in any API response,
   including new endpoints (planner, damage log, dashboard widgets)
6. Fix everything found, confirm every CORRECTIONS.md item is [FIXED], commit.
```
→ **Verified (C10, 2026-07-18)** — every verify script green (`lifecycle` 106 ·
`steadfast` 95 · `dashboard` 47 · `stock` 29 · `courier-cost` 20 ·
`purchase-dues` 30 · `leads` 28 · `targets` 50 · `attendance` 46 · `pnl` 38 ·
`reports` 47 · `test:bom` 24), production build clean, merged to `main`.
- **Items 1+3**: new `verify-lifecycle` §10 — a nested combo (PKG-004 = sub-package
  + choice group) ordered with the NON-default variant: reserve/deduct follow the
  chosen explosion exactly (default variant untouched), cost snapshot = chosen-pick
  recursive BOM cost, availability drops by exactly 1 per pack; then the §6j
  CONFIRMED-tab send (auto-pack pre-network via `autoPackForHandover`) →
  `pending` → rider ASSIGNED → `delivered_approval_pending` (stays IN_TRANSIT) →
  `delivered` → COD reconciliation settles the due. Item 2 was already §8.
- **Item 4**: new `verify-lifecycle` §11 — trash releases the reservation
  (on-hand untouched), restore re-reserves, and the 30-day purge dry-run picks
  ONLY a >30-day row, cascades items/history and keeps the immutable stock ledger.
- **Item 5**: live probe as Sanjoy (SE) against the dev server — orders
  list/detail (incl. the R7 courier block), products, packages, occasions,
  role-home dashboard and leads carry ZERO cost markers (admin control run
  proves the scanner catches `avgCost`/`unitCost`/`courierCost`); planner,
  delivery-schedule and damaged-stock report redirect SEs away, the Steadfast
  balance API 403s.
- **6a**: Delivered widget now falls back to the `order_status_history`
  DELIVERED timestamp when a delivered order has no `shipment.delivered_at`
  (`lib/dashboard.ts`), proven by a live +1/−1 check in `verify-dashboard`.
- **6b**: `formatDuration` already produced `45m` / `5h 20m` / `5d 3h` —
  pinned by 8 regression checks in `verify-steadfast`.
- **6c**: every Snapshot widget (§1/§2/§4/§5/§7 + §3) is now compared to a
  DIRECT DB query for the same range in `verify-dashboard`.
- **Stale-script fixes found by the pass**: `verify-reports` sale-side
  aggregates now exclude DRAFT like the report code (Leads §10); `verify-pnl`
  RBAC loop skips the inactive "Steadfast (system)" machine account.

---

## Dashboard

> Keep ALL existing dashboard widgets as they are — the following are ADDITIONS. All new widgets must respect the existing date-range switch (Today / Week / Month / Custom).

> → Fixed (C9): a new **Snapshot** KPI strip at the top of the **Owner Dashboard** (`components/dashboard/owner-dashboard.tsx`), above the existing Money row — every prior widget is untouched. All seven figures follow the existing date-range switch: the new fields are aggregated in **`lib/dashboard.ts#buildOwnerDashboard`** off the same `DashWindow` (leads/orders/delivered/drafts by `created_at` in range, collections by `payment_date` in range) and exposed as `data.snapshot`. Verified end-to-end against the seeded demo DB (`npm run verify:dashboard`, 38 checks) and in the running app.

1. [FIXED] Add a **Leads** widget: total lead count for the selected date range.
   → Reuses the combined lead total (detailed leads + `lead_daily_counts` bulk entries, Leads §6); links to `/leads`.
2. [FIXED] Add an **Orders** widget: total order count (quantity) for the selected range.
   → In-range order count excluding lost/draft statuses (`EXCLUDED_SALE_STATUSES`), matching the Money row's order count; links to `/orders`.
3. [FIXED] Add a **Delivered** widget: delivered order **count + total amount (৳)** for the selected range.
   → Counts by **delivery date**: orders whose `shipment.delivered_at` falls in the range (scoped to `DELIVERED`/`COMPLETED`), with Σ `total_amount`; links to `/orders?status=DELIVERED`. Independent of the funnel, which keeps its created-in-range stage view.
4. [FIXED] Add an **Advance Collection** widget: number of advance payments + total advance amount (৳) for the selected range (payment type = ADVANCE).
   → `payment.groupBy` on type `ADVANCE` (rejected payments and trashed-order payments excluded, same rule as the collection report).
5. [FIXED] Add a **Total Collection** widget **with breakdown by payment source**. Breakdown lines: **Advance** (type ADVANCE/PARTIAL), **Courier COD** (type COD_COURIER), **Post-delivery bKash/MFS** (type POST_DELIVERY_MFS — this happens when the customer pays the due via bKash after the parcel is shipped and the courier COD is set to 0). Show each source's amount + the grand total. Sometimes only 2 sources have values, sometimes all 3 — always show whichever are non-zero (or all 3 with 0 values, whichever looks cleaner).
   → All three source lines always shown (each a colored dot + amount) with the grand total = their sum; sums come from the same in-range `payment.groupBy` by type (advance line = ADVANCE + PARTIAL).
6. [FIXED] Add a **Courier Balance** widget: current Steadfast balance via the existing /get_balance integration (with a small refresh icon; show "—" if integration disabled).
   → Client tile (`components/dashboard/courier-balance-tile.tsx`) fetches the existing `/api/couriers/steadfast/balance` route on mount + on the refresh icon, so a slow/failing courier API never blocks the dashboard; shows "—" when the integration is off (`snapshot.courierEnabled`) or the viewer lacks `courier.manage`.
7. [FIXED] Add a **Draft Orders (Pending Payment)** widget: DRAFT order **count + total amount (৳)** for the selected date range — this is the committed-but-unpaid pipeline (see Leads item 10). Clicking it goes to the Orders page "Pending Payment (Drafts)" tab.
   → In-range `DRAFT` count + Σ `total_amount`, amber when non-zero; links to `/orders?status=DRAFT` (the "Pending Payment (Drafts)" tab).

## Leads

1. [FIXED] Lead entry form field order: **WhatsApp number input comes FIRST**, then Country.
2. [FIXED] **Country auto-detection**: when a WhatsApp number is typed with a country code (e.g. +966…), auto-select the matching country. Must remain manually changeable afterward. Default (before/without detection) = **KSA**.
3. [FIXED] Pre-filled defaults on the lead entry form (all editable):
   - Status = **New** (already exists — keep)
   - Country = **KSA**
   - Source = **WhatsApp**
   - Follow-up date = **entry date + 1 day** (editable)
4. [FIXED] Lead list: default filter is currently ALL TIME which loads too much — change default to **This Month**. Add **pagination**: page-size selector (25 / 50 / 100 rows) + page navigation.
5. [FIXED] "Today's follow-ups: 0" and "Overdue: 6 — follow up now" currently look like buttons, but they are notices — redesign them as notice/alert badges (info style for today's follow-ups, warning/red style for overdue), clearly not clickable-button styled. Keep the "follow up now" link behavior if it navigates somewhere.
6. [FIXED] Verify that everywhere a total lead count is shown (dashboard widget, lead report, conversion rate), the total = individual lead entries + bulk daily-count entries (lead_daily_counts) combined. E.g. 10 manual + 30 bulk on the same day must show 40 for that day.
7. [FIXED] Restructure the Leads page like the Orders page: landing page = the lead LIST. A **"New Lead"** button at the top-right opens a separate lead entry page. Users who have the bulk-entry permission see **two** buttons: "New Lead" and "Bulk Lead" (separate bulk entry page). Users without bulk permission see only "New Lead". (New `leads.bulk` permission — seeded to Admin/Manager/TeamLeader.)
8. [FIXED] **Assign-on-entry**: users with the lead-assign permission get an "Assign to" select at the END of the New Lead form — default = their own name, but they can pick another SE while entering. Users WITHOUT the assign permission don't see this field at all (lead auto-assigns to themselves).
9. [FIXED] Add a new lead status **`Committed`** (after `Negotiating`, before `Converted`): customer has verbally confirmed the order and promised the advance payment but hasn't paid yet (will pay in an hour / 10 hours / next day). Important status — show a **"Committed" queue** prominently (SE dashboard + lead list filter) with time-since-commitment, because these need chasing until payment lands.
10. [FIXED] **Draft Order stage** (for Committed leads who already gave full details): add order status **`DRAFT`** before `CONFIRMED`.
    - From a lead (or the order form), SE can save a full order (recipient details, address, items, amounts) as DRAFT — no advance payment required to save.
    - DRAFT orders: **no stock reserve, no invoice, excluded from sales/collection reports** — they are not sales yet.
    - When the advance payment arrives, SE opens the draft, records the payment (method + txn ID) → order flips to CONFIRMED via the existing rule (advance > 0), stock reserves, invoice generates — no data re-typing.
    - Lead auto-status: creating a draft sets the lead to `Committed` (linked); confirming the draft flips the lead to `Converted`.
    - Add a **"Pending Payment (Drafts)"** list/tab on the Orders page with aging (e.g. red if older than 24h) so committed-but-unpaid orders never get forgotten. Include a draft→confirm conversion metric in the lead/SE reports.
    - DRAFT orders get a temporary number (e.g. DRAFT-XXXX); the real GV-YYMM-XXXX number is assigned at CONFIRM time so the sales numbering stays clean.

## Orders

1. [FIXED] **Requested Delivery Date** on the order form (and draft orders): the date the customer wants the parcel delivered to the recipient. Three modes via a small selector:
   - **ASAP / Urgent** — deliver as soon as possible
   - **Any day** — no specific date (flexible)
   - **Fixed date** — date picker; must be delivered ON that date (birthdays/anniversaries — can be up to a month+ ahead)
   Show this clearly on the order detail, invoice, packing queue, and shipment/handover screens (Fixed dates highlighted, e.g. 🎯 badge).
2. [FIXED] **Delivery Schedule view** for Packing/Operations (and Admin/Manager): a date-wise section/page showing which deliveries are due on which date —
   - Filter options: **Today, Tomorrow, Next 7 days, This Month, Next Month, Custom date range**
   - **Today's deliveries** (due today, grouped at top)
   - **Tomorrow / upcoming** dates in a separate section, grouped by date
   - ASAP orders always appear in Today's section until handed over; "Any day" orders in a flexible group
   - Sort/filter the packing queue by requested delivery date so the team packs in the right priority order.
   → Fixed: new **`/delivery-schedule`** page (nav under Inventory, gated `orders.pack`). `lib/delivery.ts#buildDeliverySchedule` scopes to pre-courier orders (CONFIRMED + PACKED — "until handed over"), groups by requested date: **Overdue** (past fixed dates), **Today** (today's fixed + all ASAP), **Tomorrow**, each future date, then a **Flexible — Any day** group; each row shows the delivery mode (🎯 fixed date / ASAP / Any day), recipient, items, SE, status. The forward-looking period presets live in the client-safe `lib/delivery-schedule.ts` (shared with the planner) via the `DeliveryPeriodFilter`. The packing queue already sorts ASAP → fixed → flexible (Orders §1); its fixed-date 🎯 badges stay.
3. [FIXED] **Late-risk alert**: an order with a Fixed date of today/tomorrow that is still not PACKED / HANDED_TO_COURIER gets a red warning flag in the queue + a count on the dashboard (e.g. "2 fixed-date deliveries at risk").
   → Fixed: late-risk = FIXED date ≤ tomorrow (Dhaka) still at CONFIRMED (un-packed). Flagged red in the Delivery Schedule (row highlight + "⚠ At risk" badge + per-group + header counts) AND in the **Packing Queue** ("⚠ At risk — deliver soon"). The dashboard shows the count via `countLateRiskDeliveries()` in the shared **`OperationsAlerts`** strip (packing roles), deep-linking the schedule.
4. [FIXED] New Order page — **Relation dropdown**: add an option covering girlfriend/boyfriend discreetly and smartly — label it **"Special One ❤"** (single option that covers both directions; most of the customer base sends to girlfriends). Keep existing options (Wife, Mother, Father, Sibling, Friend…).
5. [FIXED] New Order page — **remove the District and Thana/Upazila fields entirely**. Only the **Full Address** textarea remains (Steadfast only needs the address string).
   - **Customer-facing delivery charge: default FREE (৳0)** — Gift Valy usually absorbs delivery into product pricing. Keep the charge field on the order (editable) for exceptions.
   - Optional **per-product/package delivery charge** field in the catalog (default 0): if set, it auto-adds to the order's delivery charge when that item is added — for future use on specific products.
6a. [FIXED] **Order list — Customer column**: show the customer's phone number between the name and the country (Name → Phone → Country).
6b. [FIXED] **Order list — Recipient column**: show the recipient's phone number below the name.
6c. [FIXED] **Order list — replace the District column with an "Items" column**: shows what was ordered (package/product names). Design it so rows never break/overflow: show the first 1–2 item names as compact badges, then a **"+N more"** chip; hovering (tooltip) or clicking shows the full item list, with the order detail page as the fallback. Plan whatever looks cleanest — the key requirement is the row height stays fixed.
6d. [FIXED] **Notes system — 3 note types per order**: `Order Note` (internal), `Invoice Note` (printed on the invoice — customer visible), `Courier Note` (delivery instructions — this one should be sent as the `note` field to Steadfast on consignment creation).
   - New Order form: all 3 note inputs available (collapsible/tabbed like the reference screenshot)
   - Order list: a **Note column** with an icon/box — clicking opens a modal with 3 tabs (Order Note / Invoice Note / Courier Note) to view and update, matching the provided screenshot design ("View and update your note")
6e. [FIXED] **Order list — Action column**: three actions per row — **View details, Edit, Trash**.
6f. [FIXED] **Order Trash (soft delete)**: a "Trash" tab on the Orders page. Trashed orders sit there for **30 days**, restorable by anyone with permission during that window, then **auto-deleted permanently** after 30 days (scheduled cleanup job). Trashing/restoring writes to the audit log; trashed orders are excluded from all reports/stock reservations (release reserves on trash).
6g. [FIXED] **Status change without opening details**:
   - Single order: the status cell in the list is a dropdown showing only the statuses that order is **eligible** to move to (per the lifecycle rules) — change directly from the list
   - Multi-select: select multiple orders → a "Change status" action offering only the statuses ALL selected orders are eligible for. All existing side effects (stock reserve/deduct, history logging) must still fire exactly as they do from the detail page.
6h. [FIXED] **Bulk invoice print** from the CONFIRMED tab **and** the PACKED tab: multi-select (e.g. 20 orders) → "Print Invoices" → one print job/PDF containing all selected invoices.
6i. [FIXED] **Invoice size = half A4**: redesign the invoice so **2 invoices fit on one A4 page** (A5 landscape halves, cut line between them). Bulk print fills A4 pages two-up automatically.
6j. [FIXED] **Send to Steadfast from CONFIRMED tab too** (not only PACKED): multi-select confirmed orders → Send to Steadfast. This implicitly passes through PACKED — the system must automatically apply the PACKED transition (BOM stock deduction, cost snapshot, history entry) before the handover, so the stock math stays identical. Same for the manual "direct to Handed to Courier" path.
6k. [FIXED] **Handed to Courier tab — 2 new columns**:
   - **Courier/Consignment ID** — Steadfast's consignment_id, auto-filled after API entry
   - **Tracking Link** — clickable link to Steadfast's public tracking page (e.g. https://steadfast.com.bd/tl/XXXX); capture the link/tracking code from the API response at consignment creation and store it on the shipment. Open in new tab.
6l. [FIXED] **In Transit tab — same Consignment ID + Tracking Link columns** as the Handed to Courier tab, PLUS two more columns fetched from Steadfast per parcel:
   - **Steadfast Delivery Charge** — what Steadfast is charging for this consignment. The webhook `delivery_status` payload includes `delivery_charge`; store it on the shipment as soon as any webhook carries it. Also inspect the create-order and status API responses for a charge field and capture it if present.
   - **Steadfast Weight** — the weight Steadfast counted. Check the actual API/webhook responses for a weight field (not in the V1 doc). If absent, **fetch it from the public tracking page**: the page at the parcel's tracking link (e.g. https://steadfast.com.bd/tl/{token}) displays Weight (e.g. "4.9 KG"), COD amount, and current hub — parse the weight from that page server-side (during the polling job or on-demand refresh, cached; be gentle — only for shipments missing weight). Last fallback: our own recorded order weight with an "(ours)" marker.
   - **Tracking link discovery**: the /tl/{token} public link token is NOT in the documented API response (which only returns consignment_id + tracking_code). On the first real consignment creation, log the FULL raw API response — if it contains a tracking link/token field, store and use it. Otherwise construct the public tracking URL from tracking_code if Steadfast's tracking page supports code-based lookup (verify the URL pattern against their /tracking page). Store whichever working link is found on the shipment.
   - Show "—" until data arrives; both values live on the shipment record and feed courier cost in P&L (actual charge overrides the zone+weight estimate).
6m. [FIXED] **In Transit tab restructure — Courier Status + Rider Info + sub-tabs**:
   - **Auto-entry into In Transit**: an order moves Handed to Courier → In Transit AUTOMATICALLY the moment Steadfast receives the parcel at their warehouse (courier status becomes `pending` via webhook/polling; that's also when Steadfast records weight & delivery charge — capture them then).
   - **Remove the current order-status column** in this tab. Add a **Courier Status** column with exactly these 4 values:
     1. **Pending** — parcel received at Steadfast warehouse
     2. **Assigned** — a rider has been assigned
     3. **Delivery Approval Pending** — rider delivered the parcel but the COD hasn't been deposited at the hub / hub manager hasn't approved yet (COD NOT yet added to our Steadfast balance)
     4. **Return/Cancel Approval Pending** — same approval-wait state for cancelled/returned parcels
   - **Rider Info column**: shows "Unassigned" while Pending; when Steadfast assigns a rider, show **rider name + contact number** (courier status flips to Assigned).
   - **Final approval movements**: hub manager approves delivery → Steadfast status `delivered` → order auto-moves In Transit → **Delivered tab** (COD now in Steadfast balance). Approves return/cancel → order auto-moves to **Returned tab**.
   - **Sub-tabs inside the In Transit tab**: 4 sub-tabs named after the 4 courier statuses, each showing its **order count** (e.g. Pending (12) · Assigned (5) · Delivery Approval Pending (3) · Return Approval Pending (1)); clicking a sub-tab filters to only that courier status.
   - **Data sources**: `delivered_approval_pending` / `cancelled_approval_pending` / `pending` / `delivered` / `cancelled` all exist in the polling API statuses — map them directly. **Assigned + rider name/contact are NOT in the documented API** — parse them from the parcel's public tracking page ("Assigned To" section) during the polling job, same gentle scraping approach as weight. If a webhook/API response turns out to carry rider info, prefer that.
6n. [FIXED] **Returned tab restructure — Pending / Received sub-tabs + damage inspection**:
   - Two sub-tabs (with counts): **Pending** and **Received**
   - Returns arrive AUTOMATICALLY from In Transit (return approved at courier) into Returned → **Pending** sub-tab — the parcel is on its way back / not yet in our hands. **No stock changes at this point.**
   - When the courier physically returns the parcel to the Gift Valy warehouse, the **Packaging team** moves it Pending → **Received** — single or multi-select.
   - **Receive-time inspection dialog**: on marking Received, show every item of the order (packages exploded into their BOM products). The inspector marks each item/unit **OK** or **Damaged** — an entire product/package can be selected as damaged, or individual products inside a package:
     - **OK items → automatically added back to sellable stock** (stock movement IN_RETURN) the moment status becomes Received
     - **Damaged items → recorded in a damage log** (product, qty, order ref, date, inspector) — NOT added to sellable stock; damaged value at cost counts as a loss in P&L and appears in a damaged-stock report
   - This receive-inspection flow REPLACES the earlier "Admin approval restores stock" return step — the Packaging team's Received action with inspection IS the approval. Fully audit-logged (who received, what was marked damaged).
7. [FIXED] **Occasion dates & reminders** (repeat-sale engine): _(form fields + customer↔recipient profile schema [FIXED] in C2; Occasions menu, profile editing & reminders shipped in C8)_
   - Order entry form gets two optional date fields for the RECIPIENT: **Birthday** and **Anniversary** — saved permanently against the customer↔recipient profile, not just the order.
   - Customer profile (from the customer list) shows these occasion dates and lets anyone with access **add/edit them at any time** (occasions manageable outside orders too).
   - New separate menu **"Occasions"**: list of upcoming occasions with filters **Today, Tomorrow, Next 7 days, This Month, Custom date range** — each row: customer name + phone/WhatsApp, recipient name, relation, occasion type, date, days remaining, last order info, and a quick "Follow up" action for the SE.
   - **Reminders BEFORE the date**: configurable lead time (default e.g. 7 days before) — the occasion appears in the SE's reminder/follow-up area so the team can proactively pitch the customer ("আপনার প্রিয়জনের birthday আসছে — এবারও gift পাঠাবেন?").
   → Fixed (C8): new **`/occasions`** menu (nav under Sales, gated `orders.view_own`; rows scoped to the customers the viewer's orders reach — SE own / TL team / all). The client-safe **`lib/occasion-constants.ts`** holds the annual-recurrence math (`nextOccurrenceYmd` — next occurrence of a stored month-day, Feb-29 clamps to Feb-28 in non-leap years) and the forward-looking period presets (Today / Tomorrow / Next 7 days / This Month = today→month-end / Custom). **`lib/occasions.ts#buildOccasionWindow`** expands each profile's birthday + anniversary into separate rows whose next occurrence falls in the window, joins the customer's latest order, and sorts soonest-first; each row shows customer + phone, recipient, relation, occasion type, date, **days-remaining** chip, last order, and a **Follow up** button (pre-filled Bangla wa.me pitch). **Profile editing**: order-creating roles get **+ Add occasion** (customer lookup by phone → recipient + dates) and per-row **Edit** (change relation/name/dates; clearing both dates deletes the profile) via `/api/occasions` (POST) and `/api/occasions/[id]` (PATCH/DELETE), fully audit-logged. **Reminders**: `buildOccasionReminders` feeds the **`OccasionRemindersWidget`** on the SE + TL dashboards (occasions within the lead window), with the **configurable lead time** (`occasion_reminder_lead_days`, default 7) set at **Settings → Occasion Reminders** (`/settings/occasions`, `settings.manage`).

## Products & Packages

1. [FIXED] **Non-sellable / packaging-material products**: add a product type flag — **Sellable** vs **Component only** (packaging material):
   - Component-only products (e.g. big shipping carton, chocolate safety box, gift wrap): **no selling price** (price fields hidden/disabled), but they ARE stocked in inventory with purchase cost, low-stock threshold, and can be damaged like any product
   - They can be added to any package's BOM (e.g. Probashi Package BOM = 1 Teddy + 1 Saree combo + 1 Chocolate box + 1 Safety box + 1 Big carton) — their cost counts inside the package cost, and packing a package deducts them from stock like everything else
   - They must **NOT appear** in the order form's item picker (can't be sold standalone), nor in the sellable catalog — but they DO appear in purchases, stock reports, the Delivery Requirement Planner, and the damage log
   - Catalog list gets a filter/badge to tell the two types apart.
2. [FIXED] **Product-level components (packing materials on PRODUCTS, not just packages)**: a sellable product can have its own attached component list — e.g. **Chocolate Box needs 1 Safety Box; Saree Combo needs 1 Combo Box**:
   - Product form gets a "Packing materials" section: add component-only products + qty per unit
   - Selling that product **standalone** → at PACKED, its components deduct from stock too, and their cost is included in the product's effective cost for P&L
   - When the product sits **inside a package**, the BOM explosion automatically pulls in the product's own components as well — so the package BOM should list only the products + package-level materials (big carton), NOT re-list each product's own box, otherwise it would double-count. Migration/UI hint: show the auto-included components read-only inside the package BOM view so the team can see the full explosion
   - Requirement Planner, stock reports, and damage inspection all work off the fully exploded list (product + its components + package-level materials).
3. [FIXED] **Product & Package forms — optional Weight + zone-wise Delivery Charge fields**:
   - **Weight** (kg/g, optional): on products; package weight auto-sums from BOM (incl. components) but stays editable/overridable
   - **Delivery Charge (optional, customer-facing)**: THREE values per product/package — **Inside Dhaka / Sub Dhaka / Outside Dhaka**. Default all 0 (= free delivery, the usual case)
   - On the order form: a recipient **zone selector** (3 zones); if any ordered item has zone charges set, the order's delivery charge auto-fills from the matching zone (multiple charged items → sum; still editable per order). This supersedes the earlier single per-product delivery-charge note in Orders item 5.
4. [FIXED] **BOM quantity must drive cost + stock everywhere** (verify & fix if not already so): when building a package BOM, each line has a product + **quantity input** (e.g. KitKat × 5). Everything must scale by that qty:
   - Package cost auto-calc = Σ (component avg cost × qty) — updates live as qty is typed in the package form
   - Packing one package deducts qty × units from stock (5 KitKats per package; 3 packages = 15)
   - Package availability = min over components of (stock ÷ qty required)
   - Requirement Planner, damage inspection, and package weight auto-sum all multiply by the BOM qty
   - Same rule for product-level components (e.g. 2 Safety Boxes per Chocolate Box if ever needed).
5. [FIXED] **Nested packages (combo packages) + variant choices**:
   - **A package BOM line can be a PRODUCT or another PACKAGE** (sub-package). Example:
     - "Chocolate Box" package = Safety Box + Wishing Card + Dairy Milk × 5 + KitKat × 6 …
     - "Saree Box" package = its own item list
     - **"Probashi Combo Package" = Chocolate Box (package) + Saree Box (package) + Teddy + Big Carton**
   - Sub-packages stay independently sellable (Chocolate Box sells alone too) — editing the Chocolate Box recipe automatically updates every combo that contains it (single source of truth)
   - **Recursive explosion** for everything: cost, weight, stock deduction at packing, availability (min across the whole tree), Requirement Planner, damage inspection. Prevent cycles (a package can never contain itself, directly or indirectly) and cap nesting at 2–3 levels
   - **Variant / choice slots** (Lal Teddy vs Pink Teddy): a BOM line can also be a **CHOICE group** — "choose 1 from: [Red Teddy, Pink Teddy]" (with a default marked). At order entry, when a package containing choice groups is added, the SE is prompted to pick each choice; the chosen variant is stored on the order item, shown on the packing queue/order detail, and its stock is what gets reserved/deducted
   - Cost/P&L uses the actually chosen variant's cost; catalog/estimate views use the default option. Package availability shows with the default, with per-variant availability visible in the package detail.

## Stock / Purchase

1. [FIXED] **Delivery Requirement Planner** (purchase planning — for Admin, Manager, Accounts, Owner): a screen using the SAME date filters as the Delivery Schedule (Today, Tomorrow, Next 7 days, This Month, Next Month, Custom). For all orders (CONFIRMED + PACKED not yet handed over; optionally include DRAFT with a toggle) whose requested delivery falls in the selected period:
   - Compute total **required packages and products** (explode packages into products via BOM)
   - Compare against current stock and show per product: **required qty, in-stock qty, shortage qty**
   - Status per row: ✅ enough / ⚠ short by X pcs
   - For every short product show **unit buying price (current avg cost, editable estimate) × shortage = purchase amount needed**, plus a **grand total: "এই period-এর delivery দিতে হলে purchase-এ কত টাকা লাগবে"**
   - One-click: generate a **purchase requisition list** (product, shortage qty, est. cost) that can be printed/exported or pre-fills the purchase entry form
   - Be careful not to double-count: stock already reserved by the same period's confirmed orders counts as available for them — requirement math must compare period demand vs on-hand correctly.
   → Fixed: new **`/stock/requirement-planner`** page (nav under Inventory, gated `purchases.create` — a cost-privileged role by design). `lib/requirement-planner.ts#buildRequirementPlan` explodes every fixed-in-window + ASAP order (CONFIRMED + PACKED, DRAFT via the toggle) through the BOM engine to stock-tracked leaves (components included), and per product shows **Required / In stock / Shortage / editable unit cost / purchase amount**, with a grand total in Bangla. **No double-counting**: it compares against raw physical `stock_qty` (which still holds CONFIRMED orders' reserved-but-on-shelf units — "reserved counts as available for them"), and adds back the stock PACKED orders already deducted (the `+N packed` note) so a packed order nets zero shortage. Editing a unit cost recomputes the amounts + total live. One-click requisition = **Download CSV**, **Print**, or **Pre-fill purchase entry** (hands the short products to the New Purchase dialog via sessionStorage: qty = shortage, cost = the estimate).

## Courier / Shipments

1. [FIXED] **Courier COST calculation by zone + weight** (this is what WE pay the courier — separate from the customer-facing delivery charge, which is usually free):
   - Replace district-based zone charges with a simple 3-zone rate table per courier: **Inside Dhaka / Sub Dhaka (Dhaka suburbs) / Outside Dhaka**, each with a base rate + per-kg rate (configurable in courier settings)
   - Add an optional **weight (kg/gram) field on products** (and auto-sum for packages via BOM); order weight = sum of items, editable at handover
   - At handover/shipment entry: select zone (3 options) + weight (pre-filled from items) → **courier cost auto-calculated** and saved as the shipment's expected cost
   - When the Steadfast webhook later sends the actual `delivery_charge`, it overrides the estimate as `courier_cost_actual` (P&L always uses actual when available, else the estimate)
2. [FIXED] **Simplify the Courier menu — Steadfast only**:
   - Remove the multi-courier setup entirely for now: **no "Courier companies" CRUD, no "Returns" submenu, no "Shipments" submenu** under Courier (returns now live in Orders → Returned tab; shipment info lives in the order tabs' columns)
   - The Courier page itself = the **Steadfast Integration** page (move it here from Settings): API key + secret, Test Connection, balance, webhook Callback URL + Bearer token, "last webhook received", Sync Now
   - Plus the **zone rate config** on the same page: Inside Dhaka / Sub Dhaka / Outside Dhaka — base + per-kg rates (used for courier cost estimates per the new plan)
   - Keep the underlying schema multi-courier-capable (courier table stays) so other couriers can be added later without a rebuild — just don't show UI for adding them now.

## Payments / Collection
_(এখনো কিছু নেই)_

## Expenses
_(এখনো কিছু নেই)_

## Targets & Rewards
_(এখনো কিছু নেই)_

## Attendance
_(এখনো কিছু নেই)_

## Reports
_(এখনো কিছু নেই)_

## Users / Settings
_(এখনো কিছু নেই)_

---

## ROUND 1.5 — Post-C6 fixes (run BEFORE continuing to C7)

R1. [FIXED] [CHANGE] **Sync Now buttons on order tabs**: add a "Sync Now" button (same behavior as the one on the Steadfast Courier page) to the **Handed to Courier** tab and the **In Transit** tab — clicking syncs the Steadfast status/data of the orders currently in that tab (with a spinner + "last synced" hint).
   → Fixed: `runSteadfastPoll` gained `{ statuses, force }`; the tab button POSTs `/api/couriers/steadfast/sync` scoped to that tab's status and forced past the poll interval, with a spinning `RefreshCw` and a "Last synced …" line fed by `courier_integrations.last_sync_at`.

R2. [FIXED] [BUG] **Courier Status jumps to Assigned too early**: parcels received at the Steadfast warehouse show Courier Status **Assigned** even though NO rider is assigned yet (Rider Info empty). Correct behavior: warehouse receive → **Pending**; flip to **Assigned** ONLY when a rider is actually detected (rider name/contact parsed from the tracking page, or from API data). Audit the status mapping logic — likely the API `pending` status or a tracking-page event is being mis-mapped to Assigned.
   → Fixed: `pending` still maps to sub-state PENDING; ASSIGNED now requires a REAL rider (name AND contact) via `realRider()`, enforced in `ingestDeliveryStatus`, in `fetchPublicTracking` (a bare name/hub is dropped) and in the tracking-page flip. ASSIGNED is never stored without matching rider info, and the ratchet only holds ASSIGNED when a rider is on record. Belt-and-suspenders: `displayedCourierStatus()` renders/filters/counts any ASSIGNED-without-rider row as Pending, so the exact symptom can't render. Regression-tested in `verify:steadfast`.

R3. [FIXED] [BUG] **Steadfast delivery charge not appearing in the In Transit tab**: the charge Steadfast counted is not populating the Steadfast Delivery Charge column. Debug the capture path (webhook `delivery_charge`, API responses, tracking-page parse) — the value must land on the shipment and render in the column as soon as Steadfast has it.
   → Fixed: root cause — the charge was only captured from the delivered-webhook; the status API (`{status, delivery_status}`) never carries it and the tracking-page parse ignored it, so an In Transit parcel showed "—" until delivery. Now `fetchPublicTracking` extracts the charge and the poll writes it to `courier_cost_actual` (new `wantsCharge` gate, cached like the weight, never clobbering a webhook value). `DELIVERY_CHARGE_KEY` broadened + case-insensitive (`delivery_charge`/`total_delivery_charge`/`delivery_fee`/…), so any spelling in any response is mined. Regression-tested.

R4. [FIXED] [CHANGE] **Ours vs Steadfast comparison display**: for each In Transit shipment show BOTH sides clearly: **Our estimate** (order weight from items + zone-rate calculated delivery charge = "এই percel-এর weight X kg, charge ৳Y হওয়ার কথা") and **Steadfast actual** (their counted weight + their charge). Show as two sub-values in the Weight and Delivery Charge columns (e.g. "Ours: 2.5kg / SF: 2.9kg") with a highlight when Steadfast's number exceeds ours by more than a configurable tolerance — so overcharging is caught instantly.
   → Fixed: the Weight and SF-Charge columns now render "Ours: … / SF: …" (`OursVsSf`); the SF line turns red with a ⚠ when `isOvercharged()` fires (SF > ours × (1 + tol%)). Tolerance is Admin-configurable on the Courier page (settings key `courier_overcharge_tolerance_pct`, default 10%). The "…হওয়ার কথা" estimate is the row's title/tooltip. Charge comparison stays cost-gated per role.

R5. [FIXED] [CHANGE] **Admin manual status overrides** (for when Steadfast has issues and statuses must be corrected by hand):
   - Admin can **Trash an order from ANY status**
   - Admin can manually move **Handed to Courier → In Transit, Delivered, or Cancelled**
   - Admin can manually move **In Transit → Delivered or Cancelled**
   - These manual moves fire all the normal side effects (stock, COD reconciliation queue, history) and are clearly marked in the order history as "manual override by <admin>" — Admin (or a dedicated permission) only.
   → Fixed: new **`orders.courier_override`** permission (seeded Admin-only; the RBAC layer auto-grants Admin every permission row — migration `20260718000000`). On the Handed to Courier / In Transit tabs a ⚠ (ShieldAlert) row action opens the courier-stage targets (In Transit / Delivered / Returned-Cancelled), routed through the existing `PATCH /api/shipments/[id]` with `manualOverride:true` → same `applyShipmentStatus` side effects (stock, COD reconciliation queue via DELIVERED, history), and the history note reads **"Manual override by &lt;admin&gt;"**. Trash-from-any-status: the trash route lets an override holder past `TRASHABLE_STATUSES` (physically-out stock stays deducted; a dialog warns; audit action `order.trash_override`). "Cancelled" in the courier world = **Returned** (parcel comes back), which then flows through the normal return-receive inspection.

R6. [FIXED] [CHANGE] **Time-in-status tracking for In Transit (stuck-parcel detection)**:
   - Track timestamps of every courier-status entry (already logged in shipment history) and show two durations per In Transit parcel:
     - **Total time in In Transit** (since warehouse receive) — e.g. "৫ দিন ৩ ঘণ্টা"
     - **Time in CURRENT courier sub-status** (Pending/Assigned/Delivery Approval Pending/Return Approval Pending) — e.g. "Assigned-এ ২ দিন"
   - Show both as a Duration column (compact: "5d 3h · this status 2d") in the In Transit tab and its sub-tabs
   - **Sort + filter by duration**: sort longest-first, and a quick filter like "stuck more than X days" (X input, default 3) to instantly list parcels sitting too long in any status
   - Color escalation: duration badge turns amber past a configurable threshold, red past a higher one (defaults e.g. 3d / 5d, editable on the Courier page)
   - A small "stuck parcels" count on the In Transit tab header (and optionally the dashboard) so long-pending deliveries are impossible to miss.
   → Fixed: two new shipment clocks (migration `20260718010000`) — **`in_transit_at`** (set at the single choke point `applyShipmentStatus` on the first move to In Transit → total time) and **`courier_status_at`** (re-stamped by `ingestDeliveryStatus` + the tracking-page rider flip whenever the courier sub-status changes → time in current status); existing rows backfilled from `order_status_history`. `courier-constants.ts` gained `formatDuration()` / `daysSince()` / `stuckLevel()`. The In Transit tab shows a **Duration** column ("5d 3h · this status 2d", amber→red by the current-sub-status age), a **"⚠ N stuck"** header count (≥ amber days), a **"Stuck more than X days"** filter (default = amber threshold) and a **longest-first sort** (`sort=stuck`, forced by the filter). Amber/red thresholds are Admin-configurable on the Courier page (settings `courier_stuck_amber_days` / `courier_stuck_red_days`, defaults 3d/5d). The dashboard carries the same stuck count (deep-links the filter). Durations compute against a server-provided `nowMs` so SSR and hydration agree.

R7. [FIXED] [CHANGE] **Courier info block on the Order Details page**: all the courier data currently visible only as list columns must also appear in a "Courier / Shipment" section on the order details page — **Consignment ID, tracking link (clickable), courier status + rider info, Steadfast's counted weight & delivery charge, our estimated weight & delivery charge (Ours vs SF side by side with the same overcharge highlight), time-in-status durations (R6), and the shipment status timeline** (tracking events already stored). One glance at an order's details = the full courier picture.

R8. [FIXED] [CHANGE] **Steadfast Payments sync — automatic COD reconciliation** (data source: `GET /payments` and `GET /payments/{payment_id}` from the Steadfast V1 API — the payment invoice contains: Amount Delivered, Payable Delivery Charge, COD Charge, Available Balance, and the list of cleared consignments with per-parcel COD + bill):
   - Poll `GET /payments` (with the hourly poller + a "Sync payments" button on the Courier page); store each payment: Steadfast payment id/invoice no (e.g. SFC-30699149), date, status (**processing / paid**), amount delivered, payable delivery charge, COD charge, net amount
   - For each new/updated payment, fetch `GET /payments/{payment_id}` → its consignments → **match `consignment_id` to our shipments** and AUTO-reconcile: create the COD_COURIER payment row on each matched order (per-parcel COD from the payload), set cod_received, and post the ACTUAL per-parcel delivery charge (the "bills" value) as courier_cost_actual + the COD fee expense — replacing estimates with real numbers
   - Unmatched consignments (not in our system) → flagged list for manual review; already-reconciled orders are skipped (idempotent)
   - **UI — "Steadfast Payments" section on the Courier page**: payment list (date, invoice no, status badge processing/paid, parcels count, net amount) + detail view mirroring their invoice breakdown; a **"Paid today/this range: ৳X (N parcels)"** summary, and a dashboard line under Courier Balance showing the latest payout
   - Wallet link: when a payment is `paid`, record the net amount as an incoming transfer to the linked bank wallet (so wallet running balances stay true)
   - **"Request Payment" shortcut button** next to the Courier Balance (Courier page + dashboard widget): visible/enabled only when the Steadfast balance is > 0 — opens the Steadfast merchant panel's payment request page in a new tab (no payment-request API exists in their documented V1, so this is a deep-link shortcut; the request itself is made in their panel, and our /payments sync picks up the resulting processing → paid record automatically)
   - **Sync button on the dashboard's Total Collection widget**: a small refresh icon that triggers the Steadfast payments sync and refreshes the widget — so after a payout the owner can pull the latest Courier COD figures instantly without leaving the dashboard
   - **Accounting rules (owner's decision — NET collection)**:
     - **Dashboard Total Collection → "Courier COD" line = NET payout** (e.g. ৳17,172 — what actually reached the bank), sourced from paid Steadfast payment records in the range. Small hover/tooltip shows the breakdown: "Gross COD ৳18,300 − delivery charge ৳955 − COD charge (1%) ৳173"
     - **Per-ORDER payment rows stay GROSS** (৳5,500 etc.) so each customer's due settles correctly — the customer DID pay the full COD; Steadfast deducted charges before remitting. Never record net against an order's due.
     - Expenses: post the delivery charge total under a **"Courier Delivery Charge"** expense category and the 1% COD fee under **"COD Charge"** — both auto-posted per paid payment (real numbers from the payment invoice)
     - Wallet: NET amount recorded as the bank deposit. Net collection + the two expense lines must always reconcile back to gross (net + charges = gross) — add this as a verify-script check.
   → Fixed: **Engine** — `lib/steadfast-payments.ts`: `runSteadfastPaymentsSync` fetches `GET /payments` (+ per-invoice `GET /payments/{id}`, ≤10/run, Laravel-pagination followed up to 3 pages) and routes every payout through `ingestSteadfastPayment` — one transaction per payment, network strictly outside transactions. Since the response shapes are NOT fully documented, parsing is fully defensive (`lib/steadfast-payments-constants.ts`: envelope hunting for the payment/consignment arrays, tolerant key patterns for every field incl. the per-parcel "bill", net derived from gross − charges when absent) and the FIRST real raw list/detail payloads are stored verbatim on the new **`steadfast_payments`** row (`raw_payload` / `raw_detail_payload`; consignments in **`steadfast_payment_items`**, migration `20260718020000`). Matching: `consignment_id` → shipment, their invoice (= our order_no) as fallback; unmatched items keep a null shipment = the flagged-for-review list. Money moves ONLY at **paid** (never on processing/ambiguous statuses, and PAID never downgrades): each matched un-reconciled parcel gets its **GROSS per-parcel COD** as a verified `COD_COURIER` payment row (settles the due; capped at the outstanding so a stray figure can't go negative), `cod_received` set, and the per-parcel bill written to `courier_cost_actual` (the invoice is authoritative over webhook/tracking figures); the payable delivery charge + COD charge post ONCE per payout as real-number expenses (**"Courier Delivery Charge"** / **"COD Charge"**, ref `steadfast_payments`). Payment rows + both expenses carry the payout wallet (setting `steadfast_payout_wallet_id`, picked on the Courier page), so the wallet's running balance (in − out) moves by exactly the **NET** — net + charges = gross reconciles by construction. Idempotent replay: items upsert by (payment, consignment), expenses are guarded by their id columns, re-ingesting a paid payout is a no-op. A parcel manually reconciled BEFORE its payout is skipped, but its ESTIMATED per-shipment fee expense is deleted (the payout carries the real fee) and its manual COD row is adopted as the item's payment link so the dashboard counts it once; a payout for a parcel our books don't show delivered reconciles anyway and raises `needs_attention`. **Triggers**: hourly on the existing */15 cron via its own `last_payments_sync_at` clock, the Courier-page **Sync payments** button, and the dashboard Total-Collection **refresh icon**. **UI**: the Courier page gained a "Steadfast payments" card — payout list (date, invoice no, processing/paid badge, parcels w/ unmatched count, net) with an expandable invoice detail (gross − delivery − COD = net, consignment rows deep-linking matched orders, red **Unmatched** badges, ⚠ when the invoice doesn't reconcile), "Paid today / this month" chips and the payout-wallet picker; **Request payment** (deep link into their merchant panel — no V1 request API exists) appears beside the balance on the Courier page and the dashboard tile while the balance is > 0. The dashboard's **Courier COD** line now shows the **NET payout** for the range (plus any payout-less manual COD at gross, never double-counted), with the "Gross − delivery charge − COD charge" hover breakdown rendered for cost-visible roles only, and a "Latest payout ৳X · N parcels" line under the Courier balance. `npm run verify:steadfast-payments` = 43 rolled-back checks on mocked payloads (parser shape tolerance, processing → paid, GROSS due settlement vs NET collection, the reconcile identity, unmatched consignments, replay idempotency, manual-overlap replacement) + a live-DB reconcile audit.

R9. [FIXED] [CHANGE] **Invoice branding settings**: a Settings page ("Business / Invoice Settings") where Admin can set **Gift Valy logo (image upload), business address, phone number(s)**, and optionally email/social handle + invoice footer text — and the invoice template (single + bulk two-up print) renders these instead of any hard-coded placeholder. Changes apply to newly generated invoices immediately.
   → Fixed: one JSON settings row (`invoice_branding`, client-safe model in `lib/invoice-branding-constants.ts`: logo, business name, tagline, address, phones, optional email/social, footer terms + closing line) replaces every hard-coded string in `lib/invoice.ts` — `DEFAULT_INVOICE_BRANDING` carries the old literals, so an untouched install renders **pixel-identical** (verified against a fresh render). New **Settings → Business / Invoice** page (`settings.manage`) with a live contact-line preview; logo uploads through a dedicated `POST /api/settings/invoice-branding/logo` (PNG/JPEG only — pdfkit can't embed WebP, which the shared /api/uploads allows — 2MB cap, saved under `/uploads`); `GET/PUT /api/settings/invoice-branding` normalizes + audit-logs. The PDF embeds the logo via `doc.image` fitted to a 64×30pt box (placeholder "GV" box when unset; upload-path re-validated and any decode failure falls back — a bad file never blocks an invoice), the contact details condense to one letterhead line with graceful ellipsis, and blank footer/closing lines simply drop out. All four render paths load branding per generation (`generateInvoice`, bulk `print-invoices`, the download-route regenerate fallback, the WhatsApp re-render), so a save reaches the very next PDF while stored versions keep their original look.

R10. [FIXED] [CHANGE] **Attendance — roster/shift-based** (replace the single global office-hours model):
   - **Shift definitions** (Admin): create shifts with name + start/end time (e.g. Morning 9:00–17:00, Evening 14:00–22:00) + late-threshold minutes per shift
   - **Weekly roster per employee**: for each employee, assign per weekday: which shift OR **off-day** (e.g. Sanjoy: Fri off, Sat–Thu Morning; Partho: Tue off, Evening shift). Editable grid UI; changes apply from a chosen effective date, history preserved
   - **Attendance evaluation follows the person's roster for that day**: late = checked in after THEIR shift start + threshold; absent = no check-in on a rostered working day; an **off-day is never counted absent** (shows as "Off day"); half-day rules relative to their own shift hours
   - Attendance reports + "who's in today" widget become roster-aware (e.g. show "Off today: Sanjoy" separately from absences)
   - Old global office-hours setting becomes the default shift for anyone without a roster.
   → Fixed: two new tables (migration `20260718030000`) — **`shifts`** (name, "HH:MM" start/end, late/half-day thresholds in minutes AFTER the shift's own start, active flag) and **`roster_assignments`** (one row per user × weekday × effective date; `shift_id` NULL = off-day, no row = default hours) — so a person's roster is a series of weekly VERSIONS resolved by "latest `effective_from` ≤ the day": changes apply only forward, past days keep evaluating under the roster they had. One pure resolver (`resolveDayPlan` in `lib/attendance-constants.ts` → a per-day `DayPlan`: shift / off / default) feeds every consumer: **`checkIn`** flags Late/Half-day against the person's OWN plan (an off-day check-in stores PRESENT — there is no shift start to be late against), the **monthly sheet / team summary** count workdays and derive ABSENT per roster (off-day never absent; per-day precedence unchanged: row → OFF → LEAVE → ABSENT), day cells carry the **shift name** (grid tooltip + a "Shift" column in the CSV/PDF exports), and **`whoIsInToday`** gained an `offToday` bucket — "Off today: X" renders separately on the widget, OFF wins over approved leave (same precedence as the sheet), "not in yet" excludes off-day folks, and each checked-in entry shows their shift. The old office-hours setting is exactly the **default shift** for anyone (or any weekday) without a roster — its settings page now says so. New Admin page **Settings → Shifts & Roster** (`settings.manage`): shift CRUD (a shift referenced by roster history can't be deleted — deactivate instead; DB-level ON DELETE RESTRICT backs this, since NULL means off-day) + the weekly roster grid: per-employee weekday selects (Default / Off / any active shift), one "Applies from" date, per-row Save writes that date's version (saving all-Default removes the version = back to office hours); `/api/shifts` + `/api/roster`, all audit-logged. The employee check-in card now describes THEIR day ("Morning 09:00–17:00 · late after 09:15", or the off-day note). Demo seed adds Morning/Evening shifts + the example rosters (Sanjoy Fri off + Morning, Partho Tue off + Evening) from the 1st of the current month. `npm run verify:attendance` grew 46 → **83 checks**: thresholds anchored to each shift's start, the same wall-clock 09:20 = LATE for a Morning-shift user but PRESENT on default hours, half-day at shift-start+240 min, off-day never absent (and OFF beats approved leave), a mid-month roster change flipping Tue→off / Fri→work only from its effective date, version history preserved, all-default clears a version, and both delete guards.

R11. [FIXED] [UI] **Responsive + full-width layout**: on large screens the dashboard (and other pages) renders in a narrow column with lots of empty space (see screenshot — big monitor, tiny centered content). Fix globally:
   - Main content should use the **full available width** (sensible max like ~1600–1920px, fluid grid: e.g. 4-up widgets on wide screens, 2-up on laptop/tablet, 1-up on mobile)
   - Audit ALL pages (dashboard, order tabs/tables, planner, schedule, courier, reports) for the same narrow-container issue and make the whole app responsive across devices — wide desktop, laptop, tablet, and phone (tables get horizontal scroll or card collapse on small screens)
   - Typography/spacing scale so numbers on the dashboard are comfortably readable on a big monitor.
   → Fixed: the width cap moved from the pages to the LAYOUT — `<main>` now wraps content in one `mx-auto w-full max-w-[1800px]` container, and the per-page straitjackets came off: the Owner Dashboard (`max-w-6xl`) and all four role homes, Targets + Manage Targets, both Attendance pages and the Order Details page are **full-width** (their internal `sm:grid-cols-2 lg:grid-cols-4` grids already fan out 4-up wide / 2-up laptop / 1-up phone); the Courier page and the order form widened 3xl/4xl → 5xl (config/form pages keep a sensible centered cap on purpose — settings forms, lead entry, login stay narrow). Audit result: list/report/planner/schedule pages never had wrappers (they were already bounded only by the new layout cap), every table rides the shadcn Table primitive's built-in `overflow-x-auto` (page body never scrolls sideways — verified `scrollWidth == clientWidth` at 375/768/1280/1880px), and dialog/input `max-w-*`s were left alone. **Typography**: root font-size steps 16 → 17px at ≥1920px and 18px at ≥2400px — every Tailwind size/space is rem-based, so type AND spacing scale together on big monitors. **Phones actually got navigation**: the sidebar is hidden below `md` and there was NO menu at all — new `components/mobile-nav.tsx` hamburger opens a slide-over drawer with the same SidebarNav tree (closes on link tap / backdrop / Escape); the header hides the email + role badge on tiny widths so it no longer crowds.

**Verification** — how to test each:
- **R1**: On the Handed to Courier / In Transit tab click **Sync now** — spinner runs, toast reports "N parcels checked, M updated", the "Last synced …" line updates. Needs `courier.manage` + an enabled integration.
- **R2 (simulate the rider transition)**: Take an In Transit parcel (or push one there via a `pending` webhook/poll). While Steadfast's tracking page has **no rider**, it sits under the **Pending** sub-tab, badge "Pending", Rider Info "Unassigned". To simulate the flip without a live rider, POST the webhook with a real rider block: `{"notification_type":"delivery_status","consignment_id":<CID>,"status":"pending","rider":{"name":"Karim","phone":"01711111111"}}` (Bearer webhook token) — or set `shipments.rider_name`+`rider_phone`+`courier_status='ASSIGNED'` directly. It then moves to the **Assigned** sub-tab with the rider shown. A name-only rider (no phone) is rejected and stays Pending. `npm run verify:steadfast` covers the whole ladder.
- **R3**: With no delivered-webhook yet, run **Sync now** on In Transit; once Steadfast's tracking page reports the charge it lands in the SF-Charge column. To simulate: send a webhook/poll payload carrying `delivery_charge` (or `total_delivery_charge`) → the column fills immediately. (`courier_cost_actual` also still fills from the delivered webhook.)
- **R4**: Set the tolerance on the Courier page (e.g. 10%). An In Transit row shows "Ours: X / SF: Y" in both Weight and SF-Charge; when SF exceeds ours beyond the tolerance the SF value goes red with ⚠.
- **R5**: As Admin, on a Handed to Courier / In Transit row use the ⚠ action to move status (add an optional reason) → order history shows "Manual override by &lt;you&gt;"; a Delivered override drops the order into the COD reconciliation queue. Trash any courier-stage/delivered order from the row's trash icon (warned + audit-logged). A Manager (no override permission) sees neither control and is blocked by the API.
- **R6**: Open **Orders → In Transit**. Each row's **Duration** column shows total-in-transit + "this status …"; older parcels go amber then red (seeded orders span both). The header shows **"⚠ N stuck"**; set the amber/red thresholds on the **Courier** page (Stuck-parcel escalation) and reload to see the colours/count shift. Type a number in **"Stuck more than X days" → Filter** to narrow the tab to long-sitting parcels (auto-sorted longest-first); the **Duration** header toggles longest-first sort on its own. The **dashboard** (Admin/Manager/Accounts/Packing) shows the same stuck count, linking straight to the filtered tab.
- **R7**: Open any handed-over/In-Transit order's **details** → the **Courier / Shipment** card shows Consignment ID, a clickable tracking link, courier status + rider, **Weight (ours / SF)** and (cost-visible roles) **Courier charge (ours / SF)** with the red ⚠ overcharge highlight past the tolerance, a **Time in transit** line with the amber/red escalation, and the tracking timeline. Log in as a Sales Executive: the charge comparison + estimate are absent (weights still show).
- **R8**: `npm run verify:steadfast-payments` exercises the whole flow on mocked payloads inside a rolled-back transaction (43 checks). Live: pick the payout wallet in **Courier → Steadfast payments**, request a payment in the Steadfast panel (**Request payment** appears beside the balance while it's > 0), then click **Sync payments** — the payout lists as *Processing* and, once Steadfast disburses, a later sync flips it to *Paid*: every cleared order gains a GROSS `COD_COURIER` payment row (due → 0), the **Courier Delivery Charge** + **COD Charge** expenses post with the invoice's real numbers, the wallet's running balance rises by exactly the NET, and the dashboard's **Courier COD** line shows the NET with the "Gross − charges" hover (cost-visible roles). Expand a payout row for the invoice breakdown — unmatched consignments carry a red **Unmatched** badge; ⚠ marks an invoice where net + charges ≠ gross. The dashboard Total-Collection refresh icon and the hourly cron run the same sync; replaying it changes nothing.
- **R9**: Open **Settings → Business / Invoice** (Admin): upload a PNG/JPEG logo, edit the name/address/phones/footer, Save → generate any invoice (confirm an order, or Print invoices on the Confirmed tab) and the PDF letterhead + footer show the new values with the logo in place of the "GV" box; blank the email/social and those parts drop from the contact line. With the settings untouched the invoice is pixel-identical to the pre-R9 template. A WebP upload is rejected with a clear message.
- **R10**: Open **Settings → Shifts & Roster** (Admin): create a shift (e.g. Morning 09:00–17:00, late after 15 min), then in the grid give an employee a week — a shift per weekday, one day **Off** — pick the "Applies from" date and Save the row. **My Attendance** now shows that person's own shift line on the check-in card, and their month grid marks rostered off-days "—" (never Absent). **Attendance & Leave → Who's in today** lists "Off today: X" separately from absences (an off-day even beats approved leave — same precedence as the sheet), and lateness is judged per the person's shift: a 09:20 check-in on a Morning roster is Late while a default-hours colleague is Present until 10:15. The **Attendance Report** sheet + CSV/PDF carry a Shift column and per-roster Absent/Workdays; anyone without a roster still follows the old office-hours setting. `npm run verify:attendance` (83 checks) covers off-day-never-absent, late vs own shift start, and a roster change from an effective date.
- **R11**: On a big monitor the dashboard fills the width (4-up KPI grid, capped ~1800px, larger type ≥1920px). Shrink to laptop → grids go 2-up; tablet → tables scroll inside their own container (the page never scrolls sideways); phone → widgets stack 1-up and the ☰ hamburger opens the full nav drawer (tap a link — it closes and navigates). Order Details, Targets, Attendance and the Courier page all widened; settings/entry forms stay deliberately centered.

---

## ROUND 2 — Post-launch corrections (live-production feedback)

> Context: the app is LIVE at app.giftvaly.com with real Steadfast traffic. Several of these are bugs visible only with REAL courier data — diagnose against production data (`shipment_status_logs` raw payloads, /var/log/giftvaly-cron.log on the server via SSH) before fixing.

2.1 [FIXED] [BUG] **Courier COD receive gives no update in the software**: when the courier's COD payment is received, nothing updates in our system. Diagnose the whole R8 payments-sync path in production: is the hourly poller calling GET /payments? Are the API keys entered/valid? Is the real response shape different from the parser's assumption (log the raw response)? Fix so received COD payouts actually flow in (see 2.7 for the full completion behavior).

2.2 [FIXED] [BUG] **Package (group product) component details missing on Invoice + Packing view**: when a package/combo is ordered, the invoice and the packing team's screen show only the package name — not the inner products. Fix: the Packing Queue/pack dialog must show the FULL BOM explosion (each component product + qty, chosen variants, packing materials) as the pick list; the Invoice shows the package name plus an indented list of its included items (customer-friendly names, qty only, no costs).

2.3 [FIXED] [CHANGE] **Product search box**: add search (name/SKU) to the product/catalog list AND the order form's item picker (type-ahead). Packages searchable too.

2.4 [FIXED] [BUG] **Rider Info never appears in the In Transit tab** (production): rider name/phone stay empty even after riders are assigned. Diagnose the tracking-page scraper against REAL production tracking pages (fetch a live parcel's page; check the current HTML for the "Assigned To" block — markup may have changed or the section may be JS-rendered). Fix the parser; if the data is genuinely not obtainable, show "—" with a "view tracking page" link instead of silently empty.

2.5 [FIXED] [BUG] **Webhook status times are wrong**: Steadfast webhook timestamps (`updated_at` = "YYYY-MM-DD HH:MM:SS") are stored/displayed with the wrong time — almost certainly a timezone bug (they send Asia/Dhaka local time with no zone marker; we're likely parsing as UTC → +6h skew). Fix: parse Steadfast times as Asia/Dhaka, store UTC, display Dhaka. Audit ALL Steadfast time fields (webhook updated_at, tracking events, poll stamps) and correct existing skewed production rows with a data migration if feasible.

2.6 [FIXED] [BUG] **Delivery/Return Approval Pending stage is skipped**: when the rider delivers, the order jumps straight to the Delivered tab. Correct behavior: rider delivery → courier status **Delivery Approval Pending**, order STAYS In Transit; only when Steadfast finalizes (hub approval — COD added to their wallet, status becomes final `delivered`) does the order move to Delivered. Same for returns (Return Approval Pending → final `cancelled` → Returned). Likely root cause: the webhook sends `delivered` at rider-delivery time while the poll API distinguishes `delivered_approval_pending` — so on any webhook `delivered`/`cancelled`, cross-check the status API; if it reports `*_approval_pending`, hold the order In Transit with that sub-status.

2.7 [FIXED] [CHANGE] **COD payout justification + auto-COMPLETE engine** (extends R8 — the full money trail):
   - **Per-order math**: `COD − courier delivery charge = subtotal; subtotal − 1% COD fee = NET receivable` (e.g. 5,500 − 215 = 5,285; − 52.85 ≈ 5,232.15). That NET is what Steadfast adds to their wallet at final delivery.
   - **Two new In Transit columns**: (a) **Courier deduction** = delivery charge + 1% COD fee for this order; (b) **Net receivable** = COD − deduction. Computed live (SF actual charge when known, else our estimate).
   - **On payout** (payment request → processing → paid, with per-consignment breakdown):
     1. Match each consignment ID to our order
     2. Compare Steadfast's paid amount per consignment vs OUR computed net receivable
     3. **Match** → order auto-moves DELIVERED → **COMPLETED**: gross COD payment row settles the due, delivery charge + COD fee post as expenses, net recorded into the bank wallet
     4. **Mismatch** → order gets a ⚠ marker + an entry in a **discrepancy list** (order, our amount, their amount, difference); it does NOT complete until Admin/Accounts resolves (accept their figure with a reason, or mark disputed)
   - **Payout report**: per Steadfast payment — total paid vs Σ our expected nets, per-consignment comparison table, discrepancy count — every taka that hit the bank justified against orders.

2.8 [BUG] **Blank white page on iPhone (all iOS browsers)**: the login page renders completely blank on iPhones while Android Chrome works. All iOS browsers share the OS-pinned WebKit engine — almost certainly a modern-JS feature (regex lookbehind, structuredClone, crypto.randomUUID, Array.at, etc.) crashing older Safari before hydration. Fix: scan source + built bundles for iOS-incompatible syntax, add a browserslist target covering the team's iOS versions, rebuild + verify, and add a global client error boundary (visible "reload" message instead of silent white) so future crashes are never invisible.
