# SETUP — Antu Boutique CRM

Do these once, before the first Claude Code prompt in `BUILD_PROMPTS.md`.

---

## 1. Local folder and repo

The repo already exists: `https://github.com/Soft-IT-Care-Ltd/Antu-Boutique-CRM.git`

```bash
cd ~/Desktop
# if the folder is empty, connect it to the repo:
cd "Antu Boutique CRM"
git init
git remote add origin https://github.com/Soft-IT-Care-Ltd/Antu-Boutique-CRM.git
git branch -M main
git add .
git commit -m "docs: PRD, build prompts and repo guide"
git push -u origin main
```

Requires Node **20 LTS or newer** (`node -v`).

---

## 2. Database — a fresh Neon project

1. Open the Neon console → **New project** → name it `antu-boutique-crm`, region Singapore (closest to BD).
2. Copy **both** connection strings:
   - **Pooled** → `DATABASE_URL`
   - **Direct / non-pooler** → `DIRECT_URL`
3. This database must be **completely separate from Gift Valy's**. Never point this app at Gift Valy's database, not even for a test.

---

## 3. Secrets — all fresh, never reused from Gift Valy

```bash
openssl rand -base64 32   # → NEXTAUTH_SECRET
openssl rand -hex 32      # → COURIER_ENCRYPTION_KEY
openssl rand -hex 32      # → CRON_SECRET
```

`COURIER_ENCRYPTION_KEY` encrypts the courier (Steadfast) API credentials stored in the database. Once the system is live, **changing it breaks the courier integration** until the credentials are re-entered. Keep it safe from day one.

---

## 4. `.env`

Copy `.env.example` to `.env` and fill in:

```
DATABASE_URL="postgresql://...pooler..."
DIRECT_URL="postgresql://...direct..."
SHADOW_DATABASE_URL="postgresql://...direct.../antu_shadow"   # throwaway DB — Prisma WIPES it; never the real one
TEST_DATABASE_URL="postgresql://...direct.../antu_test"       # integration tests only — never the real one
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="..."
COURIER_ENCRYPTION_KEY="..."
CRON_SECRET="..."
UPLOAD_DIR="./public/uploads"
MAX_UPLOAD_MB="5"
```

`.env` is in `.gitignore`. Never commit it.

`SHADOW_DATABASE_URL` points at a separate, throwaway database on the same Neon server (`CREATE DATABASE antu_shadow`). Prisma empties it every time a migration is generated, so it must **never** be the same database as `DATABASE_URL` / `DIRECT_URL` (CLAUDE.md rule 11).

`TEST_DATABASE_URL` points at a second throwaway database on the same server (`CREATE DATABASE antu_test`). `npm test` runs every `*.integration.test.ts` file against it, one file at a time, and never touches the dev database: it refuses to start unless the database name ends in `_test` and differs from `DATABASE_URL` / `DIRECT_URL` / `SHADOW_DATABASE_URL`. Before the tests run it applies pending migrations (`migrate deploy`) and re-runs the seed whenever the schema, migrations or seed changed. If it reports that an applied migration no longer matches its file (a migration edited after the tests applied it), rebuild the test database — **with the owner's OK** (CLAUDE.md rule 11): `DROP DATABASE antu_test; CREATE DATABASE antu_test;`, then run `npm test`.

Leave `STEADFAST_LIVE_API` **unset** on every development machine. Until it is `enabled`, the app refuses to book real Steadfast parcels.

---

## 5. Open Claude Code in this folder

```bash
cd "~/Desktop/Antu Boutique CRM"
claude
```

Claude Code reads `CLAUDE.md` automatically. Then work through `BUILD_PROMPTS.md`, one phase at a time.

---

## 6. Things to have ready before Phase 2 and 3

| Needed for | What to collect |
|---|---|
| Courier module (Phase 2) | Steadfast API key + secret, and the delivery-charge table per zone for every courier used |
| Payments (Phase 2) | The list of wallets actually used: bKash personal/merchant, Nagad, Rocket, bank account, showroom cash — with opening balances |
| Catalog (Phase 1) | The real size list, the real colour list, category list, and 10–20 real products with photos, cost and selling price for seeding |
| POS (Phase 3) | Showroom cash-drawer opening balance and who operates it |
| Staff (Phase 0) | Names, phones and roles of every staff member who will log in |

---

## 7. Going live (Phase 5)

Deployment follows the same shape as the Gift Valy server runbook: VPS + Node 20 + PM2 + Nginx + Certbot SSL, with real crontab entries for the Steadfast sync and trash cleanup (using `CRON_SECRET`), and a nightly `pg_dump` backup.

### Production checklist

- [ ] DNS points at the VPS **before** running `certbot`; SSL issued.
- [ ] Production `.env` has fresh `NEXTAUTH_SECRET`, `COURIER_ENCRYPTION_KEY` and `CRON_SECRET`, and `NEXTAUTH_URL=https://<your-domain>`.
- [ ] **`STEADFAST_LIVE_API=enabled`** in the production `.env` — production only. Without it, "Send to Steadfast" and the status sync are refused (only Test Connection and the balance work).
- [ ] Production database seeded **without demo data**: `SEED_ADMIN_NAME="…" SEED_ADMIN_PHONE=01XXXXXXXXX SEED_ADMIN_PASSWORD='…' npm run db:seed:base` (never `npm run db:seed` — that one adds demo people, orders and money). The Admin changes the password at first sign-in.
- [ ] **Settings**, top to bottom: business profile and logo; categories, sizes and colours; couriers and zone charges; payment methods; orders, stock & hours; reward rules; staff accounts and teams (each gets a temporary password); roles & permissions if the starting templates need changing.
- [ ] **Settings → Import opening data**, in this order, each sheet checked before it is imported (templates on the page; save from Excel as *CSV UTF-8*): products with sizes, colours and opening stock → customers (fill `owner_phone` so each Sales Executive keeps their customers) → wallet opening balances (the day each was counted).
- [ ] Steadfast API key + secret entered in **Settings → Steadfast** (also on the Courier page), **Test Connection** passes, integration switched on.
- [ ] Webhook token generated on the same page. In the Steadfast panel → Webhook Integration, set the callback URL `https://<your-domain>/api/webhooks/steadfast` and paste the Bearer token.
- [ ] Courier cost rates (Inside / Sub / Outside Dhaka) filled in on **Settings → Steadfast**.
- [ ] Crontab: Steadfast sync every 15 minutes —
      `*/15 * * * * curl -fsS -m 60 -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/steadfast-sync`
      — plus the nightly trash purge, the daily low-stock alert and the nightly backup (exact lines in `docs/BACKUPS.md`).
- [ ] `postgresql-client-18` installed (Neon runs PostgreSQL 18; an older `pg_dump` refuses), `BACKUP_DIR` set, `scripts/backup.sh` run once by hand, and **Settings → Backups & nightly jobs** shows it green.
- [ ] "Last webhook received" and "Last sync" on the Courier page start filling after the first real parcel.
- [ ] Wallets: real opening balance and opening date set (by the import, or **Settings → Payments & wallets**); any wallet the business doesn't use deactivated.
- [ ] After the first real Steadfast payout, check its stored raw data (`courier_statements.rawPayload` / `rawDetailPayload`) to confirm whether `due_bills` include return charges, and that nothing was booked twice (return charges from the condition check vs. the statement's delivery-charge expense).
