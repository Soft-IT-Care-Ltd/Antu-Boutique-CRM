# Antu Boutique CRM

Internal CRM/ERP for **Antu Boutique** — a Bangladeshi fashion boutique selling online (Messenger, Facebook, WhatsApp, Instagram) and from a physical showroom.

Runs the whole operation in one place: lead → order → stock → packing → courier → payment → profit, plus staff targets, attendance and reporting.

## Documents in this repo

| File | What it is |
|---|---|
| **`PRD.md`** | The full product requirements — modules, data model, business rules, roles, reports. The source of truth. |
| **`CLAUDE.md`** | Repo guide for Claude Code: stack, conventions, and the non-negotiable rules. Read automatically by Claude Code. |
| **`BUILD_PROMPTS.md`** | Copy-paste prompts for Claude Code, Phase 0 → Phase 5, with a verification prompt after each phase. |
| **`SETUP.md`** | One-time setup: repo, Neon database, secrets, `.env`, and what to collect before each phase. |
| **`.env.example`** | Environment variable template. |

## Start here

1. Work through **`SETUP.md`** (database, secrets, `.env`).
2. Open Claude Code in this folder.
3. Run the prompts in **`BUILD_PROMPTS.md`**, one at a time, in order.

## The two things that make this different from Gift Valy CRM

1. **One person per order** — the buyer is the recipient. No payer/recipient split, no second phone number, no country field.
2. **Optional reference images on the order** — customers send a product photo on Messenger, the sales executive attaches it (paste, upload or drag-drop), and the packing team sees it first when preparing the parcel.

## Stack

Next.js (App Router) + TypeScript · PostgreSQL (Neon) + Prisma · NextAuth + custom RBAC · Tailwind + shadcn/ui · Recharts · PDF invoices with Bangla font · PWA

---

Soft IT Care Ltd
