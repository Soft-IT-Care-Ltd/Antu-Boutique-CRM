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
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="..."
COURIER_ENCRYPTION_KEY="..."
CRON_SECRET="..."
UPLOAD_DIR="./public/uploads"
MAX_UPLOAD_MB="5"
```

`.env` is in `.gitignore`. Never commit it.

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

Two things to remember on the day:
- Point DNS at the VPS **before** running `certbot`.
- Set the Steadfast webhook URL on the courier's panel to `https://<your-domain>/api/webhooks/steadfast`.
