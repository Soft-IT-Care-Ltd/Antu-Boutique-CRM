# Gift Valy reference — Steadfast courier integration

**Reference material only. Nothing in this folder is part of the Antu Boutique app.**

These files are copied from the Gift Valy CRM repo (`Soft-IT-Care-Ltd/Gift-Valy-CRM`), where the Steadfast integration has been running in production with real parcels. Read them to learn the Steadfast API's real behaviour and the bugs already found and fixed — then write Antu's own implementation against Antu's own schema.

- `STEADFAST_INTEGRATION.md` — the integration spec: API endpoints, payload mapping, webhook, polling, status mapping, schema, acceptance tests.
- `CORRECTIONS.md` — the owner's correction list for Gift Valy. For courier work read **"Courier / Shipments"**, **Prompt C5**, **Prompt C6**, and all of **"ROUND 2 — Post-launch corrections"** (2.1, 2.4, 2.5, 2.6, 2.7 are courier/COD bugs that only showed up with real Steadfast traffic).
- `code/` — the working Gift Valy source files. Folder separators are flattened to `__` (`lib__steadfast.ts.txt` = `lib/steadfast.ts`), and every file ends in `.txt` so TypeScript, ESLint and Next.js ignore them. **Do not rename them to `.ts`, do not import from them.**

## Adapt, don't copy — Antu is different in these ways

| Gift Valy | Antu Boutique |
|---|---|
| Two people per order: `recipient_name`, `recipient_phone_bd` + the expat payer | **One person**: `customer.name`, `customer.phone`, optional `customer.altPhone` → Steadfast `alternative_phone` |
| `note` = occasion + requested delivery date + order notes | **No occasion.** Never send the order's internal staff note to Steadfast — the rider sees `note`. Send only delivery instructions. |
| Order numbers `GV-YYMM-NNNN` | `AB-YYMM-NNNN` |
| Integer ids, its own `lib/orders.ts`, `lib/authz.ts`, `lib/settings.ts` | Antu's cuid ids and Antu's own helpers (`lib/auth/permissions.ts`, `lib/auth/scope.ts`, `lib/orders/*`) |
| No variants | Items are **variants** (size + colour); `item_description` should include them |
| No partial delivery in lifecycle until later | Boutique customers often keep 1 of 2 items — partial delivery must be handled (see the P2.2 prompt) |
