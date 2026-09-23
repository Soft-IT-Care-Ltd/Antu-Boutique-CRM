# CLAUDE.md — Antu Boutique CRM

Read this before writing any code in this repo. The full requirements live in **`PRD.md`** — treat it as the source of truth. The build order and ready-made prompts are in **`BUILD_PROMPTS.md`**.

---

## What this project is

An internal CRM/ERP for **Antu Boutique**, a Bangladeshi fashion boutique selling **online** (Messenger/Facebook/WhatsApp/Instagram) and from a **physical showroom**. It runs lead → order → stock → packing → courier → payment → profit, plus staff targets, attendance and reporting.

The feature set is carried over from **Gift Valy CRM** (`Soft-IT-Care-Ltd/Gift-Valy-CRM`) and adapted. **Nothing is shared at runtime** — separate repo, separate database, fresh secrets.

### Two things that differ from Gift Valy — never get these wrong

1. **One person per order.** The buyer is the recipient. One name, one phone, one address, plus an optional alternate contact number. There is **no payer/recipient split, no second phone, no country dropdown, no sender message, no gift occasion**. If you find yourself writing a "recipient" field, stop — that is Gift Valy's model, not this one.
2. **Optional reference images on the order.** Customers send a product photo on Messenger instead of naming the item. The order form accepts up to 5 images (file picker, drag-drop, **and Ctrl+V paste**), optionally tagged to a line item, and the **Packing team sees them first** on the packing queue and packing slip. The field is always optional — an order must never be blocked because there is no image.

---

## Stack

- **Next.js (App Router) + TypeScript**
- **PostgreSQL (Neon) + Prisma**
- **NextAuth** credentials + a custom RBAC layer
- **Tailwind + shadcn/ui**, mobile-first, PWA-installable
- **Recharts** for charts
- **Zod** on every API route
- **sharp** for image compression/thumbnails
- Local `/uploads` for files, served through an **auth-checked route** (not a public static path)
- PDF invoice + packing slip with an **embedded Bangla font**

---

## Stack gotchas

Learned the hard way in P0.1 — don't rediscover these:

- This shadcn install is **base-ui powered (`@base-ui/react`), not Radix**. Don't reach for Radix APIs or docs.
- **`asChild` does not exist.** Base UI components take a `render` prop instead: `<SidebarMenuButton render={<Link href="/x" />}>` not `<SidebarMenuButton asChild><Link ...></SidebarMenuButton>`.
- **`DropdownMenuLabel` must be wrapped in a `DropdownMenuGroup`.** Base UI's menu requires every label/item to sit inside a group — an unwrapped `DropdownMenuLabel` breaks. See `components/app-shell/topbar.tsx` for the working pattern.
- **Generating a migration without a TTY:** `prisma migrate dev` refuses to run non-interactively. Use `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$SHADOW_DATABASE_URL" --script > prisma/migrations/<ts>_<name>/migration.sql`, then `npx prisma migrate deploy`. The shadow URL is ONLY ever `SHADOW_DATABASE_URL` (rule 11).
- Future phases must follow this — check how an existing `components/ui/*` primitive is used elsewhere before assuming Radix conventions apply.
- **iPhones and the showroom iPad (P3.0).** Client code must run on iOS Safari 15. The `browserslist` in `package.json` lowers syntax, but it never adds missing functions. After `npm run build`, run **`npm run check:ios`**: it fails on syntax old Safari can't parse (one bad chunk = a blank page, Gift Valy Round 2 §2.8) and on runtime APIs that aren't polyfilled. Missing APIs go in `lib/browser/polyfills.ts`. Never call `crypto.randomUUID()` in client code — use `newLocalId()` from `lib/browser/local-id.ts` (randomUUID is also missing over plain `http://`). Tailwind v4's CSS itself needs iOS **15.4+** (cascade layers, `oklch`), so iOS 15.0–15.3 devices must update (every iOS 15 device can reach 15.8).

---

## Non-negotiable rules

Check these on every change. They are the rules the business runs on.

1. **`order.due_amount` is always recomputed** from `total − sum(payments)` server-side. Never accept it from the client.
2. **A stock change and its `stock_movements` row are written in one transaction.** No stock write without a ledger row, ever.
3. **`unit_cost_snapshot` freezes at `PACKED`** and never changes — historical profit must not move when today's purchase price changes.
4. **`payments.transaction_id` is globally unique** where not null.
5. **Cost / profit / margin / purchase price are stripped at the API layer** for any role without `product.cost.view`. Hiding them in the UI is not enough — the JSON response must not contain the field.
6. **List queries are scoped server-side by role**: Sales Executive → own records only, Team Leader → own team. A client-sent filter can never widen the scope. Use the shared query-scope helper; do not hand-roll it per route.
7. **Every sensitive mutation writes an `audit_logs` row** (order edit, price change, payment edit/delete, stock adjustment, permission change, image delete, exchange approval): actor, action, entity, before/after JSON, timestamp.
8. **Soft delete, never hard delete** for orders, customers, products — trash with 30-day restore, purged by cron.
9. **Zod-validate every API input.** Never trust the client.
10. **Stock is reserved at `CONFIRMED`, deducted at `PACKED`.**
11. **Never aim a database-wiping command at a real database.** Never pass `DATABASE_URL` or `DIRECT_URL` to any command that can reset or wipe a database — `prisma migrate diff --shadow-database-url`, `prisma migrate reset`, `prisma db push --force-reset`, `DROP SCHEMA`/`DROP DATABASE`, or anything like them. Shadowing uses **only** `SHADOW_DATABASE_URL` (the throwaway `antu_shadow` database, wired as `shadowDatabaseUrl` in the Prisma datasource). **Any destructive database command needs the owner's explicit OK first — even on dev.** (Learned the hard way in P2.2: a shadow URL pointed at `DIRECT_URL` wiped the dev database.)

---

## Conventions

- **Folder shape:** `app/(dashboard)/<module>/…` for screens, `app/api/<module>/…` for routes, `lib/` for shared logic, `components/` for UI, `prisma/` for schema, seed and migrations.
- **Money:** store as integer paisa or `Decimal` — never a float. Display as `৳ 1,42,000` (BD lakh formatting).
- **Dates:** store UTC, display Asia/Dhaka.
- **IDs:** cuid. Order numbers are human-readable and sequential: `AB-2609-0001`.
- **Server-side by default.** Use Server Components and server actions/route handlers; reach for client components only for interactive widgets.
- **Permission checks live in one place** (`lib/auth/permissions.ts` + a route guard). Never scatter role string comparisons through the codebase.
- **Every list screen** has: search, filters, pagination, empty state, and a loading skeleton.
- **Bangla text** must render correctly in the UI and in generated PDFs.

---

## Roles

`ADMIN` · `MANAGER` · `TEAM_LEADER` · `SALES_EXECUTIVE` · `PACKING` · `ACCOUNTS` · `POS_OPERATOR`

Permissions are granular strings grouped into role templates, with per-user overrides. See PRD §3.

---

## Definition of done (every phase, every feature)

- [ ] Seeded demo data exists so the screen can be judged with real-looking content
- [ ] **Role-tested**: log in as a Sales Executive — no cost, no profit, no other SE's data, anywhere, including raw API responses
- [ ] Zod validation on every new route
- [ ] Audit log on every new sensitive mutation
- [ ] Works on a phone-sized viewport
- [ ] `npm run build` passes with no type errors

---

## Working agreement for Claude Code

- Before building a module, **re-read its section in `PRD.md`** — don't build from memory of this file.
- When the PRD and a quick idea conflict, **the PRD wins**; if the PRD is genuinely wrong or silent, ask before inventing.
- Build **one phase at a time**, in the order given in `BUILD_PROMPTS.md`. Do not skip ahead.
- After each phase, run the phase's **verification prompt** and fix what it finds before moving on.
- Keep commits scoped to one feature with a clear message.
- Never commit `.env`, `/uploads` contents, or real customer data.
