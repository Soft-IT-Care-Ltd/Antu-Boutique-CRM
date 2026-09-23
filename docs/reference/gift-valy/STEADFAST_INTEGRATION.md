# Steadfast Courier API Integration — Spec

> Extends `GIFT_VALY_SOFTWARE_SPEC.md` §7 (Courier & Delivery). Read that first.
> Official API doc (V1): base URL `https://portal.packzy.com/api/v1`, auth via `Api-Key` + `Secret-Key` headers, `Content-Type: application/json`.

---

## 1. Settings — Connect Steadfast

Admin-only settings page: **Settings → Courier Integrations → Steadfast**

| Field | Notes |
|---|---|
| API Key | encrypted at rest, never sent to client after save (show masked `****...abc`) |
| Secret Key | same |
| Enabled toggle | on/off |
| Polling interval | default 15 minutes |

**"Test Connection" button** → calls `GET /get_balance`. Success → show "Connected ✓ — Current balance: ৳X" and store `connected_at`. Failure → show the error, don't enable.

Also show current Steadfast balance as a small widget on this page (refresh button).

## 2. Send to Steadfast (from Orders → PACKED tab)

On the order list **PACKED** tab:
- Checkbox on each row + "select all" → **single and multi-select**
- Button: **"Send to Steadfast"** (visible only if integration enabled + user has `courier.manage` permission)
- Confirm dialog shows: order no, recipient name, BD phone, address, COD amount for each selected order → user confirms

**API calls:**
- 1 order → `POST /create_order`
- 2–500 orders → `POST /create_order/bulk-order` with `data` = JSON array

**Payload mapping (per order):**

| Steadfast field | From Gift Valy | Rule |
|---|---|---|
| `invoice` | `orders.order_no` (e.g. GV-2607-0142) | unique ✓ (alphanumeric + hyphen allowed) |
| `recipient_name` | `orders.recipient_name` | trim to 100 chars |
| `recipient_phone` | `orders.recipient_phone_bd` | **normalize to 11 digits**: strip `+88`/`88`, spaces, dashes → must match `01XXXXXXXXX`, else block with validation error before sending |
| `alternative_phone` | customer's number ONLY if it is a valid 11-digit BD number, else omit | |
| `recipient_address` | full address + district + thana | trim to 250 chars |
| `cod_amount` | `orders.cod_amount` | ≥ 0 |
| `note` | occasion + requested delivery date + order notes | short |
| `item_description` | item names + qty summary | |
| `delivery_type` | 0 (home delivery) | |

**On success (per order):**
1. Create/update `shipments` row: `courier = Steadfast`, `consignment_id`, `tracking_code`, `steadfast_status = in_review`, `handover_date = now`
2. Order status → **HANDED_TO_COURIER** (+ `order_status_history` entry, by = acting user, note = "Sent via Steadfast API, tracking XXXX")
3. Show result table: per order ✓ success (tracking code) / ✗ error (reason) — bulk response returns per-item `status: success/error`

**On error:** order stays PACKED, error shown, nothing written. Partial success in bulk is fine — only successful ones move.

**Guards:** skip (with warning) orders already having a Steadfast consignment; never double-send the same order_no.

## 3. Status Sync — Webhook (primary) + Polling (fallback)

### 3A. Webhook receiver (primary, real-time)

Steadfast panel → Webhook Integration lets us configure a **Callback URL** + **Auth Token (Bearer)**. Steadfast then POSTs JSON to us on every status/tracking change.

**Endpoint:** `POST /api/webhooks/steadfast`

**Auth:** generate a random secret token (32+ chars) shown once on our Settings → Steadfast page ("Webhook token" with copy button). The incoming request must have header `Authorization: Bearer <token>` — reject with 401 otherwise. Token stored hashed/encrypted in `courier_integrations.webhook_token`.

**Payload 1 — `notification_type: "delivery_status"`:**
```json
{ "notification_type": "delivery_status", "consignment_id": 12345,
  "invoice": "GV-2607-0142", "cod_amount": 1500.00, "status": "Delivered",
  "delivery_charge": 100.00, "tracking_message": "...", "updated_at": "2025-03-02 12:45:30" }
```
Handling:
1. Find shipment by `consignment_id` (fallback: by `invoice` = order_no). Not found → respond `{"status":"error","message":"Invalid consignment ID."}` with 200/404 per doc, log it
2. Map `status` (**case-insensitive** — doc lists `pending/delivered/partial_delivered/cancelled/unknown` but example sends `"Delivered"`) using the mapping table below
3. Store `delivery_charge` → `shipments.courier_cost_actual` (real courier cost for P&L)
4. Log raw payload in `shipment_status_logs` (source = WEBHOOK)
5. **Idempotent:** same status arriving twice must not duplicate history entries or re-trigger return flow
6. Respond `200` with `{"status":"success","message":"Webhook received successfully."}`

**Payload 2 — `notification_type: "tracking_update"`:** no status change — append `tracking_message` + `updated_at` to a `shipment_tracking_events` table (shipment_id, message, event_at, source). Shown as a timeline on the order/shipment detail page. Respond 200.

Unknown `notification_type` → log, respond 200 (never crash).

**Settings page additions:** show the full Callback URL to paste into Steadfast panel (e.g. `https://<our-domain>/api/webhooks/steadfast`), the Bearer token (copy button, regenerate button), and "Last webhook received at" timestamp for health visibility.

### 3B. Polling (fallback / reconciliation)

Webhooks can be missed (server down, network). Keep the polling job but relax it: every 60 minutes (setting), only for shipments in non-final states whose `last webhook/poll update` is older than the interval:

1. Fetch all shipments where `courier = Steadfast` and order status ∈ {HANDED_TO_COURIER, IN_TRANSIT}
2. For each: `GET /status_by_cid/{consignment_id}` (fallback: `/status_by_invoice/{order_no}`)
3. Map and update (same mapping, source = POLL):

| Steadfast `delivery_status` | Gift Valy order status | Extra actions |
|---|---|---|
| `in_review` | HANDED_TO_COURIER (stay) | |
| `pending` | **IN_TRANSIT** | first time only → set `in_transit_at` |
| `hold` | IN_TRANSIT (stay) | flag shipment `on_hold = true`, show ⚠ in courier report |
| `delivered`, `delivered_approval_pending` | **DELIVERED** | set `delivered_at`; if `delivered` (balance added) → mark COD as receivable in reconciliation queue |
| `partial_delivered(_approval_pending)` | PARTIAL | flag for Accounts manual review |
| `cancelled`, `cancelled_approval_pending` | **RETURNED** | trigger existing return flow (stock restore needs Admin approval per SPEC §7) |
| `unknown`, `unknown_approval_pending` | no change | flag shipment `needs_attention = true` |

4. Every webhook/poll result stored in `shipment_status_logs` (shipment_id, raw_status, source ENUM(WEBHOOK,POLL), received_at) — audit trail
5. Status change → `order_status_history` entry with `by_user = system (Steadfast webhook/sync)`
6. Manual "Sync now" button on courier page + per-shipment refresh icon

**Stop polling** a shipment once DELIVERED / RETURNED / PARTIAL (final states).

> Note: webhook `delivery_status` values are a shorter list than the V1 polling API (`in_review`, `hold` etc. only appear via polling) — the mapper must accept both sets, case-insensitively.

### 3C. Scheduled poller — deployment

The unattended poll runs through **`GET /api/cron/steadfast-sync`**, secured by the
`CRON_SECRET` env var (generate with `openssl rand -hex 32`). The request must carry
`Authorization: Bearer <CRON_SECRET>`; anything else → 401. The endpoint is a safe
no-op when the integration is disabled, and it only polls non-final Steadfast
shipments whose last webhook/poll update is older than the configured polling
interval — so the cron may fire more often than the interval without over-polling.

**Vercel** — `vercel.json` schedules it every 15 minutes; set `CRON_SECRET` in the
project's environment variables and Vercel Cron sends the Bearer header
automatically:

```json
{ "crons": [{ "path": "/api/cron/steadfast-sync", "schedule": "*/15 * * * *" }] }
```

> Vercel Hobby plan restricts cron jobs to once per day (run inside an hour-wide
> window). On Hobby, either accept daily reconciliation (the webhook remains the
> real-time source) or trigger the endpoint from any external scheduler exactly
> like the VPS setup below.

**VPS / any host with system cron** — `crontab -e` on the server (or any machine
that can reach the app) and add:

```cron
# Steadfast status reconciliation — every 15 minutes (STEADFAST_INTEGRATION.md §3B)
*/15 * * * * curl -fsS -m 60 -H "Authorization: Bearer $CRON_SECRET" https://<our-domain>/api/cron/steadfast-sync >> /var/log/steadfast-sync.log 2>&1
```

If the crontab can't read env vars, inline the secret (keep the crontab
root-readable only: `chmod 600`). The endpoint returns
`{"ok":true,"polled":N,"changed":N,"errors":[…]}` so the log doubles as a health
trail; "Last synced at" on Settings → Steadfast shows the same signal in the UI.

## 4. Schema additions

```sql
ALTER TABLE shipments ADD COLUMN consignment_id BIGINT NULL,
  ADD COLUMN steadfast_status VARCHAR NULL,
  ADD COLUMN on_hold BOOL DEFAULT false,
  ADD COLUMN needs_attention BOOL DEFAULT false,
  ADD COLUMN last_polled_at TIMESTAMPTZ NULL;
-- tracking_code already exists as tracking_no

CREATE TABLE shipment_status_logs(id, shipment_id FK NULL, raw_payload JSONB,
  raw_status, source ENUM('WEBHOOK','POLL'), received_at);
CREATE TABLE shipment_tracking_events(id, shipment_id FK, message, event_at, source);
CREATE TABLE courier_integrations(id, courier ENUM('STEADFAST'), api_key_encrypted,
  secret_key_encrypted, webhook_token_encrypted, is_enabled BOOL,
  polling_minutes INT DEFAULT 60, connected_at, last_sync_at, last_webhook_at);
```

## 5. Security & resilience

- Keys encrypted at rest; API calls server-side only (never expose keys to browser)
- Rate-limit friendly: poll in batches, small delay between calls; bulk create max 500/call
- Timeout + 2 retries with backoff on network errors; failures logged, never crash the app
- All Steadfast API errors visible in an integration log page (Admin)

## 6. Acceptance test checklist

1. Wrong keys → Test Connection fails gracefully
2. Send 1 PACKED order → appears in Steadfast panel, order flips to HANDED_TO_COURIER with tracking code
3. Multi-select 3 orders → bulk create, per-order result shown, all flip status
4. Order with `+8801XXXXXXXXX` phone → normalized and accepted; 10-digit phone → blocked with clear error
5. Webhook with wrong/missing Bearer token → 401, nothing changes
6. Webhook `delivery_status: "pending"` → IN_TRANSIT; `"Delivered"` (capitalized) → DELIVERED, `delivery_charge` saved as courier cost, COD appears in reconciliation
7. Webhook `cancelled` → order → RETURNED, return flow triggered; same webhook replayed → no duplicate history (idempotency)
8. Webhook `tracking_update` → appears in shipment timeline, status unchanged
9. Poll fallback: mock `pending` → `delivered` via polling → same result as webhook path
10. Same order can't be sent twice
```
