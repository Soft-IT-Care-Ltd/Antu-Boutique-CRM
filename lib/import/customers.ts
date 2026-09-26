import "server-only";

import type { CustomerTag, Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { BD_DIVISIONS, CUSTOMER_TAG_LABELS, CUSTOMER_TAG_VALUES } from "@/lib/customers/constants";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import type { CsvTable } from "@/lib/import/csv";
import type { ImportIssue, ImportSummaryItem } from "@/lib/import/types";
import { nameKey, readList } from "@/lib/import/values";

// PRD §4.4 — one person per customer: name, phone (unique), optional second
// number, address, notes, tags. A phone already in the system is skipped,
// not overwritten, so the sheet can be re-run after fixing a few rows.
//
// Who "owns" a customer decides who sees them (PRD §3.1: an SE sees only
// their own): owner_phone names the staff member, else the importer. The
// team is copied from the owner, as a normal create does.

type PlannedCustomer = {
  line: number;
  name: string;
  phone: string;
  altPhone: string | null;
  division: string | null;
  district: string | null;
  thana: string | null;
  addressDetail: string | null;
  notes: string | null;
  tags: CustomerTag[];
  ownerId: string;
  ownerName: string;
  teamId: string | null;
};

export type CustomerPlan = { customers: PlannedCustomer[]; skipped: number; errors: ImportIssue[]; warnings: ImportIssue[] };

function readTag(raw: string): CustomerTag {
  const key = nameKey(raw).replace(/[_-]/g, " ");
  const hit = CUSTOMER_TAG_VALUES.find((t) => nameKey(CUSTOMER_TAG_LABELS[t]) === key || t.toLowerCase().replace(/_/g, " ") === key);
  if (!hit) throw new Error(`tag "${raw}" — use VIP, Wholesale or Problem customer`);
  return hit;
}

function limit(value: string | undefined, max: number, label: string): string | null {
  const v = (value ?? "").trim();
  if (!v) return null;
  if (v.length > max) throw new Error(`${label} is longer than ${max} characters`);
  return v;
}

export async function planCustomerImport(db: Prisma.TransactionClient, table: CsvTable, actor: { id: string; name: string; teamId: string | null }): Promise<CustomerPlan> {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  for (const col of ["name", "phone"]) {
    if (!table.headers.includes(col)) errors.push({ line: null, message: `The sheet needs a "${col}" column` });
  }
  if (errors.length > 0) return { customers: [], skipped: 0, errors, warnings };

  const phones = table.rows.map((r) => r.values.phone ?? "").filter(isValidBdPhone).map(normalizeBdPhone);
  const [existing, staff] = await Promise.all([
    db.customer.findMany({ where: { phone: { in: phones } }, select: { phone: true, name: true, deletedAt: true } }),
    db.user.findMany({ where: { isActive: true }, select: { id: true, name: true, phone: true, teamId: true } }),
  ]);
  const existingByPhone = new Map(existing.map((c) => [c.phone, c]));
  const staffByPhone = new Map(staff.map((u) => [u.phone, u]));

  const customers: PlannedCustomer[] = [];
  const seen = new Map<string, number>();
  let skipped = 0;
  for (const row of table.rows) {
    try {
      const name = limit(row.values.name, 150, "name");
      if (!name) throw new Error("name is blank");
      const rawPhone = row.values.phone ?? "";
      if (!isValidBdPhone(rawPhone)) throw new Error(`phone "${rawPhone}" isn't a Bangladeshi mobile number (017XXXXXXXX)`);
      const phone = normalizeBdPhone(rawPhone);
      const twice = seen.get(phone);
      if (twice !== undefined) throw new Error(`${phone} is also on row ${twice} — one person per phone`);
      seen.set(phone, row.line);

      let altPhone: string | null = null;
      if (row.values.alt_phone) {
        if (!isValidBdPhone(row.values.alt_phone)) throw new Error(`alt_phone "${row.values.alt_phone}" isn't a Bangladeshi mobile number`);
        altPhone = normalizeBdPhone(row.values.alt_phone);
        if (altPhone === phone) throw new Error("alt_phone is the same as phone");
      }
      let division: string | null = null;
      if (row.values.division) {
        division = BD_DIVISIONS.find((d) => nameKey(d) === nameKey(row.values.division) || (nameKey(row.values.division) === "chittagong" && d === "Chattogram") || (nameKey(row.values.division) === "barisal" && d === "Barishal")) ?? null;
        if (!division) throw new Error(`division "${row.values.division}" — use one of ${BD_DIVISIONS.join(", ")}`);
      }
      const tags = [...new Set(readList(row.values.tags).map(readTag))];

      let owner = { id: actor.id, name: actor.name, teamId: actor.teamId };
      if (row.values.owner_phone) {
        const ownerPhone = isValidBdPhone(row.values.owner_phone) ? normalizeBdPhone(row.values.owner_phone) : row.values.owner_phone;
        const hit = staffByPhone.get(ownerPhone);
        if (!hit) throw new Error(`owner_phone ${row.values.owner_phone} isn't an active staff member's login phone`);
        owner = hit;
      }

      const already = existingByPhone.get(phone);
      if (already) {
        skipped += 1;
        warnings.push({ line: row.line, message: `${phone} is already ${already.name}${already.deletedAt ? " (in the Trash)" : ""} — skipped` });
        continue;
      }
      customers.push({
        line: row.line,
        name,
        phone,
        altPhone,
        division,
        district: limit(row.values.district, 60, "district"),
        thana: limit(row.values.thana, 60, "thana"),
        addressDetail: limit(row.values.address ?? row.values.address_detail, 500, "address"),
        notes: limit(row.values.notes, 2000, "notes"),
        tags,
        ownerId: owner.id,
        ownerName: owner.name,
        teamId: owner.teamId,
      });
    } catch (e) {
      errors.push({ line: row.line, message: (e as Error).message });
    }
  }
  return { customers, skipped, errors, warnings };
}

export function summarizeCustomerPlan(plan: CustomerPlan): { summary: ImportSummaryItem[]; preview: { line: number; text: string }[] } {
  const owners = new Set(plan.customers.map((c) => c.ownerId));
  return {
    summary: [
      { label: "New customers", value: String(plan.customers.length) },
      { label: "Already in the system (skipped)", value: String(plan.skipped) },
      { label: "Owners", value: String(owners.size) },
    ],
    preview: plan.customers.map((c) => ({ line: c.line, text: `${c.name} · ${c.phone}${c.district ? ` · ${c.district}` : ""} → ${c.ownerName}` })),
  };
}

export async function applyCustomerPlan(tx: Prisma.TransactionClient, plan: CustomerPlan, actorId: string, request?: Request): Promise<void> {
  for (let i = 0; i < plan.customers.length; i += 500) {
    await tx.customer.createMany({
      data: plan.customers.slice(i, i + 500).map((c) => ({
        name: c.name,
        phone: c.phone,
        altPhone: c.altPhone,
        division: c.division,
        district: c.district,
        thana: c.thana,
        addressDetail: c.addressDetail,
        notes: c.notes,
        tags: c.tags,
        createdById: c.ownerId,
        teamId: c.teamId,
      })),
    });
  }
  await writeAuditLogWith(tx, {
    actorId,
    action: "import.customers",
    entityType: "import",
    entityId: `customers-${Date.now()}`,
    after: { created: plan.customers.length, skipped: plan.skipped, phones: plan.customers.map((c) => c.phone) },
    request,
  });
}
