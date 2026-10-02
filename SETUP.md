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
TEST_DATABASE_URL="postgresql://antu_test:antu_test@localhost:5433/antu_test"   # integration tests only — local Postgres 18 (below)
NEON_TEST_DATABASE_URL="postgresql://...direct.../antu_test"  # `npm run test:neon` only — Neon's antu_test
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="..."
COURIER_ENCRYPTION_KEY="..."
CRON_SECRET="..."
UPLOAD_DIR="./public/uploads"
MAX_UPLOAD_MB="5"
```

`.env` is in `.gitignore`. Never commit it.

`SHADOW_DATABASE_URL` points at a separate, throwaway database on the same Neon server (`CREATE DATABASE antu_shadow`). Prisma empties it every time a migration is generated, so it must **never** be the same database as `DATABASE_URL` / `DIRECT_URL` (CLAUDE.md rule 11).

### Test database — a local PostgreSQL 18

`npm test` runs every `*.integration.test.ts` file against `TEST_DATABASE_URL`, one file at a time. That database lives on **this Mac**, not on Neon: round-trips to Neon (Singapore) made the full suite take far longer than the code needs. Dev and production stay on Neon. It is PostgreSQL **18** — the same major version Neon runs — on port **5433**, so it never clashes with another Postgres on the default 5432.

One-time setup. Homebrew has no PostgreSQL 18 bottle for every Mac (it tried to compile from source on the owner's), so this uses EDB's prebuilt macOS binaries — one folder, nothing installed system-wide:

```bash
# 1. Server binaries (universal: Intel and Apple silicon) into ~/.local/pgsql-18
curl -L -o /tmp/pg18.zip https://get.enterprisedb.com/postgresql/postgresql-18.6-1-osx-binaries.zip
mkdir -p ~/.local && cd ~/.local
unzip -q /tmp/pg18.zip "pgsql/bin/*" "pgsql/lib/*" "pgsql/share/*" "pgsql/include/*" "pgsql/*.txt" && mv pgsql pgsql-18

# 2. Its own data folder, on port 5433, localhost only
echo postgres > /tmp/pgpw && ~/.local/pgsql-18/bin/initdb -D ~/.local/pgsql-18-data -U postgres --auth=scram-sha-256 --pwfile=/tmp/pgpw -E UTF8 --locale=en_US.UTF-8 && rm /tmp/pgpw
# UTC like Neon — initdb copies the Mac's own zone (Asia/Dhaka), which shifts every SQL date by 6 hours
sed -i '' "s/^#port = 5432.*/port = 5433/; s/^#listen_addresses = 'localhost'.*/listen_addresses = 'localhost'/; s/^timezone = .*/timezone = 'UTC'/; s/^log_timezone = .*/log_timezone = 'UTC'/" ~/.local/pgsql-18-data/postgresql.conf
```

3. Start it at every login with a LaunchAgent, `~/Library/LaunchAgents/local.antu.postgres18.plist` (replace `YOU` with your macOS user name):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>local.antu.postgres18</string>
  <key>ProgramArguments</key>
  <array><string>/Users/YOU/.local/pgsql-18/bin/postgres</string><string>-D</string><string>/Users/YOU/.local/pgsql-18-data</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardErrorPath</key><string>/Users/YOU/.local/pgsql-18-data/server.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/local.antu.postgres18.plist
~/.local/pgsql-18/bin/pg_isready -h localhost -p 5433        # → accepting connections

# 4. The test role and database
PGPASSWORD=postgres ~/.local/pgsql-18/bin/psql -h localhost -p 5433 -U postgres -d postgres \
  -c "CREATE ROLE antu_test LOGIN PASSWORD 'antu_test' CREATEDB;" -c "CREATE DATABASE antu_test OWNER antu_test;"
```

To stop it: `launchctl unload ~/Library/LaunchAgents/local.antu.postgres18.plist`. The first `npm test` after a fresh database applies every migration and seeds it (a few minutes).

The tests refuse to start unless the database name ends in `_test` and differs from `DATABASE_URL` / `DIRECT_URL` / `SHADOW_DATABASE_URL`. Before they run they apply pending migrations (`migrate deploy`) and re-run the seed whenever the schema, migrations or seed changed. If they report that an applied migration no longer matches its file (a migration edited after the tests applied it), rebuild the test database — **with the owner's OK** (CLAUDE.md rule 11), and only ever on port 5433 (`psql -h localhost -p 5433 -U postgres -d postgres`): `DROP DATABASE antu_test; CREATE DATABASE antu_test OWNER antu_test;`, then run `npm test`.

**Before every deploy: `npm run test:neon`.** It runs the same full suite against `NEON_TEST_DATABASE_URL` — a throwaway `antu_test` database on the Neon server (`CREATE DATABASE antu_test`, direct connection string) — so the code is proven on Neon itself, not just locally. Same guards, same `_test` rule. Expect it to be several times slower than `npm test`.

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
