import "server-only";

import type { Prisma } from "@prisma/client";

import { writeAuditLogWith } from "@/lib/audit/log";
import { scopedWhere } from "@/lib/auth/scope";
import type { SessionUser } from "@/lib/auth/types";
import { isValidBdPhone, normalizeBdPhone } from "@/lib/customers/phone";
import { withTx, type Db } from "@/lib/db/tx";
import { isOpenLeadStatus, LEAD_STATUS_LABELS, type LeadLostReasonValue, type LeadSourceValue, type LeadStatusValue } from "@/lib/leads/constants";
import { leadAuditShape } from "@/lib/leads/serialize";
import { leadConvertError, leadStatusMoveError, statusAfterScheduling } from "@/lib/leads/status";

// PRD §4.5 — leads and follow-ups. Every read and write goes through the
// shared scope helper (CLAUDE.md rule 6): an executive reaches only their
// own leads, a team leader their team's. Lead edits, status moves, deletes
// and conversions are audit-logged (rule 7); deletes are soft (rule 8).

export class LeadError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

type AuditContext = { request?: Request };

/** A lead this user can reach, or a 404. Deleted leads only when asked for (restore). */
export async function findScopedLead(db: Db, user: SessionUser, id: string, opts: { deleted?: boolean } = {}) {
  const lead = await db.lead.findFirst({ where: scopedWhere({ id, deletedAt: opts.deleted ? { not: null } : null }, user) });
  if (!lead) throw new LeadError(opts.deleted ? "Lead not found in trash" : "Lead not found", 404);
  return lead;
}

/** Normalized phone, or null for none. Throws on a malformed one. */
function cleanPhone(phone: string | null | undefined): string | null {
  const trimmed = phone?.trim();
  if (!trimmed) return null;
  if (!isValidBdPhone(trimmed)) throw new LeadError("Enter a valid Bangladeshi phone number (e.g. 017XXXXXXXX), or leave it empty.");
  return normalizeBdPhone(trimmed);
}

const blankToNull = (value: string | null | undefined) => (value?.trim() ? value.trim() : null);

/** The customer with this phone, if this user can see them — never someone else's customer. */
async function visibleCustomerId(db: Db, user: SessionUser, phone: string | null): Promise<string | null> {
  if (!phone) return null;
  const customer = await db.customer.findFirst({ where: scopedWhere({ phone, deletedAt: null }, user), select: { id: true } });
  return customer?.id ?? null;
}

/** Follow-ups are set from now on (a few minutes' grace for a slow form) and within a year. */
function assertFollowUpTime(dueAt: Date, now = new Date()) {
  if (Number.isNaN(dueAt.getTime())) throw new LeadError("Pick a date and time for the follow-up.");
  if (dueAt.getTime() < now.getTime() - 5 * 60_000) throw new LeadError("That time has already passed — pick a follow-up time from now on.");
  if (dueAt.getTime() > now.getTime() + 366 * 86_400_000) throw new LeadError("Pick a follow-up within the next year.");
}

export type LeadInput = {
  name: string;
  phone?: string | null;
  source: LeadSourceValue;
  campaign?: string | null;
  interest?: string | null;
  notes?: string | null;
};

export async function createLead(db: Db, user: SessionUser, input: LeadInput & { followUpAt?: Date | null; followUpNote?: string | null }, ctx: AuditContext = {}) {
  const phone = cleanPhone(input.phone);
  if (input.followUpAt) assertFollowUpTime(input.followUpAt);
  const customerId = await visibleCustomerId(db, user, phone);

  return withTx(db, async (tx) => {
    const lead = await tx.lead.create({
      data: {
        name: input.name.trim(),
        phone,
        customerId,
        source: input.source,
        campaign: blankToNull(input.campaign),
        interest: blankToNull(input.interest),
        notes: blankToNull(input.notes),
        status: input.followUpAt ? statusAfterScheduling("NEW") : "NEW",
        createdById: user.id,
        teamId: user.teamId,
      },
    });
    if (input.followUpAt) {
      await tx.leadFollowUp.create({ data: { leadId: lead.id, dueAt: input.followUpAt, note: blankToNull(input.followUpNote), createdById: user.id } });
    }
    await writeAuditLogWith(tx, { actorId: user.id, action: "lead.create", entityType: "lead", entityId: lead.id, after: leadAuditShape(lead), request: ctx.request });
    return lead;
  });
}

export async function updateLead(db: Db, user: SessionUser, id: string, patch: Partial<LeadInput>, ctx: AuditContext = {}) {
  const existing = await findScopedLead(db, user, id);
  const data: Prisma.LeadUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name.trim();
  if (patch.source !== undefined) data.source = patch.source;
  if (patch.campaign !== undefined) data.campaign = blankToNull(patch.campaign);
  if (patch.interest !== undefined) data.interest = blankToNull(patch.interest);
  if (patch.notes !== undefined) data.notes = blankToNull(patch.notes);
  if (patch.phone !== undefined) {
    const phone = cleanPhone(patch.phone);
    data.phone = phone;
    // A converted lead stays linked to the customer its order went to.
    if (existing.status !== "CONVERTED" && phone !== existing.phone) {
      const customerId = await visibleCustomerId(db, user, phone);
      data.customer = customerId ? { connect: { id: customerId } } : { disconnect: true };
    }
  }

  return withTx(db, async (tx) => {
    const updated = await tx.lead.update({ where: { id }, data });
    await writeAuditLogWith(tx, { actorId: user.id, action: "lead.update", entityType: "lead", entityId: id, before: leadAuditShape(existing), after: leadAuditShape(updated), request: ctx.request });
    return updated;
  });
}

export type StatusChange = { status: LeadStatusValue; lostReason?: LeadLostReasonValue | null; lostNote?: string | null };

export async function changeLeadStatus(db: Db, user: SessionUser, id: string, change: StatusChange, ctx: AuditContext = {}) {
  const existing = await findScopedLead(db, user, id);
  const refused = leadStatusMoveError(existing.status, change.status);
  if (refused) throw new LeadError(refused, 409);

  let lost: Pick<Prisma.LeadUpdateManyMutationInput, "lostReason" | "lostNote" | "lostAt">;
  if (change.status === "LOST") {
    if (!change.lostReason) throw new LeadError("Pick why the lead was lost.");
    const note = blankToNull(change.lostNote);
    if (change.lostReason === "OTHER" && !note) throw new LeadError("Write down why the lead was lost.");
    lost = { lostReason: change.lostReason, lostNote: note, lostAt: new Date() };
  } else {
    // Reopening a lost lead clears the reason.
    lost = { lostReason: null, lostNote: null, lostAt: null };
  }

  return withTx(db, async (tx) => {
    // Guarded on the status we checked, so two people moving the same lead
    // at once can't both win.
    const moved = await tx.lead.updateMany({ where: { id, status: existing.status, deletedAt: null }, data: { status: change.status, ...lost } });
    if (moved.count === 0) throw new LeadError("This lead changed while you were looking at it — reload and try again.", 409);
    const updated = await tx.lead.findUniqueOrThrow({ where: { id } });
    await writeAuditLogWith(tx, {
      actorId: user.id,
      action: change.status === "LOST" ? "lead.lost" : existing.status === "LOST" ? "lead.reopen" : "lead.status",
      entityType: "lead",
      entityId: id,
      before: leadAuditShape(existing),
      after: leadAuditShape(updated),
      request: ctx.request,
    });
    return updated;
  });
}

export async function scheduleFollowUp(db: Db, user: SessionUser, leadId: string, input: { dueAt: Date; note?: string | null }) {
  const lead = await findScopedLead(db, user, leadId);
  if (!isOpenLeadStatus(lead.status)) {
    throw new LeadError(lead.status === "LOST" ? "Reopen the lead before setting a follow-up." : `A ${LEAD_STATUS_LABELS[lead.status]} lead doesn't need follow-ups.`, 409);
  }
  assertFollowUpTime(input.dueAt);

  return withTx(db, async (tx) => {
    const followUp = await tx.leadFollowUp.create({ data: { leadId, dueAt: input.dueAt, note: blankToNull(input.note), createdById: user.id } });
    const next = statusAfterScheduling(lead.status);
    if (next !== lead.status) await tx.lead.updateMany({ where: { id: leadId, status: lead.status }, data: { status: next } });
    return followUp;
  });
}

/** Marks a follow-up done, optionally setting the next one in the same step. */
export async function completeFollowUp(db: Db, user: SessionUser, followUpId: string, input: { outcome?: string | null; next?: { dueAt: Date; note?: string | null } | null }) {
  const followUp = await db.leadFollowUp.findFirst({ where: { id: followUpId, lead: scopedWhere({ deletedAt: null }, user) }, include: { lead: true } });
  if (!followUp) throw new LeadError("Follow-up not found", 404);
  if (followUp.completedAt) throw new LeadError("This follow-up is already done.", 409);
  if (input.next) {
    if (!isOpenLeadStatus(followUp.lead.status)) throw new LeadError("This lead is closed — no next follow-up needed.", 409);
    assertFollowUpTime(input.next.dueAt);
  }

  return withTx(db, async (tx) => {
    const done = await tx.leadFollowUp.updateMany({ where: { id: followUpId, completedAt: null }, data: { completedAt: new Date(), completedById: user.id, outcome: blankToNull(input.outcome) } });
    if (done.count === 0) throw new LeadError("This follow-up is already done.", 409);
    if (input.next) {
      await tx.leadFollowUp.create({ data: { leadId: followUp.leadId, dueAt: input.next.dueAt, note: blankToNull(input.next.note), createdById: user.id } });
      const next = statusAfterScheduling(followUp.lead.status);
      if (next !== followUp.lead.status) await tx.lead.updateMany({ where: { id: followUp.leadId, status: followUp.lead.status }, data: { status: next } });
    }
    return { leadId: followUp.leadId };
  });
}

export async function deleteLead(db: Db, user: SessionUser, id: string, ctx: AuditContext = {}) {
  const existing = await findScopedLead(db, user, id);
  if (existing.status === "CONVERTED") throw new LeadError("A converted lead stays on record — it's part of its order's history.", 409);
  return withTx(db, async (tx) => {
    const deleted = await tx.lead.update({ where: { id }, data: { deletedAt: new Date() } });
    await writeAuditLogWith(tx, { actorId: user.id, action: "lead.delete", entityType: "lead", entityId: id, before: leadAuditShape(existing), after: leadAuditShape(deleted), request: ctx.request });
    return deleted;
  });
}

export async function restoreLead(db: Db, user: SessionUser, id: string, ctx: AuditContext = {}) {
  const existing = await findScopedLead(db, user, id, { deleted: true });
  return withTx(db, async (tx) => {
    const restored = await tx.lead.update({ where: { id }, data: { deletedAt: null } });
    await writeAuditLogWith(tx, { actorId: user.id, action: "lead.restore", entityType: "lead", entityId: id, before: leadAuditShape(existing), after: leadAuditShape(restored), request: ctx.request });
    return restored;
  });
}

// ---------------------------------------------------------------------------
// Conversion (PRD §4.5): the order form, opened from a lead, is pre-filled
// from it; placing the order sets order.leadId and closes the lead.
// ---------------------------------------------------------------------------

/** Checks, before the order is written, that this user may convert this lead. */
export async function assertLeadConvertible(db: Db, user: SessionUser, leadId: string) {
  const lead = await db.lead.findFirst({ where: scopedWhere({ id: leadId, deletedAt: null }, user) });
  if (!lead) throw new LeadError("That lead isn't one you can convert.", 400);
  const refused = leadConvertError(lead.status);
  if (refused) throw new LeadError(refused, 409);
  return lead;
}

/**
 * Inside the order's own transaction, right after the order (with leadId
 * set) is created: closes the lead as CONVERTED and links it to the
 * order's customer. orders.leadId is unique, so a lead converts once even
 * when two people race; the status guard here says so in plain words.
 */
export async function markLeadConverted(tx: Prisma.TransactionClient, input: { leadId: string; customerId: string; orderId: string; actorId: string; request?: Request }) {
  const before = await tx.lead.findUniqueOrThrow({ where: { id: input.leadId } });
  const moved = await tx.lead.updateMany({
    where: { id: input.leadId, status: { not: "CONVERTED" }, deletedAt: null },
    data: { status: "CONVERTED", convertedAt: new Date(), customerId: input.customerId, lostReason: null, lostNote: null, lostAt: null },
  });
  if (moved.count === 0) throw new LeadError("This lead has already been converted to an order.", 409);
  const after = await tx.lead.findUniqueOrThrow({ where: { id: input.leadId } });
  await writeAuditLogWith(tx, {
    actorId: input.actorId,
    action: "lead.convert",
    entityType: "lead",
    entityId: input.leadId,
    before: leadAuditShape(before),
    after: { ...leadAuditShape(after), orderId: input.orderId },
    request: input.request,
  });
}
