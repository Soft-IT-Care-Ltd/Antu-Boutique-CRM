import type { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Route handlers call auth(); the session is whatever the test says it is.
const session = vi.hoisted(() => ({ current: null as null | { user: { id: string; role: string; teamId: string | null } } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session.current) }));

import { GET as leadsGET } from "@/app/api/leads/route";
import { GET as leadGET } from "@/app/api/leads/[id]/route";
import { GET as reportGET } from "@/app/api/leads/report/route";
import { POST as ordersPOST } from "@/app/api/orders/route";
import type { SessionUser } from "@/lib/auth/types";
import { sessionUserFor, uniquePhone } from "@/lib/courier/__tests__/helpers";
import { getDailySheet, mergeDailyRows, saveDailySheet } from "@/lib/leads/daily-counts";
import { listDueFollowUps, listLeadPeople, listLeads } from "@/lib/leads/queries";
import { getLeadConversionReport } from "@/lib/leads/report";
import { changeLeadStatus, completeFollowUp, createLead, deleteLead, LeadError, markLeadConverted, scheduleFollowUp } from "@/lib/leads/service";
import { prisma } from "@/lib/prisma";
import { inRolledBackTransaction } from "@/lib/test/rollback";
import { todayInDhaka } from "@/lib/inventory/constants";

// P4.1 — leads (PRD §4.5). Writes run in a rolled-back transaction; the
// route checks read the seeded demo leads (prisma/seed.ts seedLeadsDemo)
// and never write.

const SE = "01711000004";
const TL = "01711000003";
const ADMIN = "01711000001";
const POS = "01711000007";

const inHours = (h: number) => new Date(Date.now() + h * 3_600_000);

function asSession(user: SessionUser) {
  session.current = { user: { id: user.id, role: user.role, teamId: user.teamId } };
}

/** A second executive on no team, so "another SE's data" has something in it. */
async function otherExecutive(tx: Prisma.TransactionClient): Promise<SessionUser> {
  const role = await tx.role.findUniqueOrThrow({ where: { name: "SALES_EXECUTIVE" } });
  const u = await tx.user.create({ data: { name: "Other SE", phone: uniquePhone(), passwordHash: "x", roleId: role.id } });
  return { id: u.id, role: "SALES_EXECUTIVE", teamId: null };
}

beforeEach(() => {
  session.current = null;
});

describe("lead scoping (CLAUDE.md rule 6)", () => {
  it("an executive sees only their own leads; a team leader their team's; the owner everyone's", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [se, tl, admin] = await Promise.all([SE, TL, ADMIN].map(sessionUserFor));
      const other = await otherExecutive(tx);
      const theirs = await createLead(tx, other, { name: "Not yours", source: "MESSENGER" });

      const seList = await listLeads(tx, se, { status: undefined }, { page: 1, pageSize: 100 });
      expect(seList.items.length).toBeGreaterThan(0);
      expect(seList.items.every((l) => l.owner?.id === se.id)).toBe(true);

      // A client-sent owner filter narrows, never widens.
      const widened = await listLeads(tx, se, { ownerId: other.id }, { page: 1, pageSize: 100 });
      expect(widened.total).toBe(0);

      const tlList = await listLeads(tx, tl, {}, { page: 1, pageSize: 100 });
      expect(tlList.items.some((l) => l.owner?.id === se.id)).toBe(true);
      expect(tlList.items.some((l) => l.id === theirs.id)).toBe(false);

      const adminList = await listLeads(tx, admin, {}, { page: 1, pageSize: 200 });
      expect(adminList.items.some((l) => l.id === theirs.id)).toBe(true);

      // Due follow-ups and the executive picker are scoped the same way.
      await scheduleFollowUp(tx, other, theirs.id, { dueAt: inHours(1) });
      expect((await listDueFollowUps(tx, se)).items.every((f) => f.owner?.id === se.id)).toBe(true);
      expect((await listLeadPeople(tx, se)).map((p) => p.id)).toEqual([se.id]);
      expect((await listLeadPeople(tx, tl)).map((p) => p.id)).toEqual(expect.arrayContaining([se.id, tl.id]));
    });
  });

  it("the API: another executive's lead is a 404, and POS staff can't list leads at all", async () => {
    const [se, tl, pos] = await Promise.all([SE, TL, POS].map(sessionUserFor));
    const tlLead = await prisma.lead.findFirstOrThrow({ where: { createdById: tl.id, deletedAt: null } });

    asSession(se);
    const res = await leadGET(new NextRequest(`http://localhost/api/leads/${tlLead.id}`), { params: Promise.resolve({ id: tlLead.id }) });
    expect(res.status).toBe(404);
    const list = await (await leadsGET(new NextRequest(`http://localhost/api/leads?status=all&ownerId=${tl.id}`))).json();
    expect(list.total).toBe(0);

    asSession(pos);
    expect((await leadsGET(new NextRequest("http://localhost/api/leads"))).status).toBe(403);
  });
});

describe("the funnel", () => {
  it("LOST needs a reason (and words for Other); reopening clears it; CONVERTED is never picked by hand", async () => {
    await inRolledBackTransaction(async (tx) => {
      const se = await sessionUserFor(SE);
      const lead = await createLead(tx, se, { name: "Test lead", phone: "017 5512 9999", source: "WHATSAPP" });
      expect(lead.phone).toBe("01755129999");

      await expect(changeLeadStatus(tx, se, lead.id, { status: "LOST" })).rejects.toThrow(/why/);
      await expect(changeLeadStatus(tx, se, lead.id, { status: "LOST", lostReason: "OTHER" })).rejects.toThrow(/Write down/);
      await expect(changeLeadStatus(tx, se, lead.id, { status: "CONVERTED" })).rejects.toThrow(/order is placed/);

      const lost = await changeLeadStatus(tx, se, lead.id, { status: "LOST", lostReason: "PRICE" });
      expect(lost).toMatchObject({ status: "LOST", lostReason: "PRICE" });
      expect(lost.lostAt).not.toBeNull();

      const reopened = await changeLeadStatus(tx, se, lead.id, { status: "FOLLOW_UP" });
      expect(reopened).toMatchObject({ status: "FOLLOW_UP", lostReason: null, lostAt: null });

      const audits = await tx.auditLog.findMany({ where: { entityType: "lead", entityId: lead.id }, orderBy: { createdAt: "asc" } });
      expect(audits.map((a) => a.action)).toEqual(["lead.create", "lead.lost", "lead.reopen"]);
    });
  });

  it("the database refuses a lost lead without a reason", async () => {
    await inRolledBackTransaction(async (tx) => {
      const se = await sessionUserFor(SE);
      const lead = await createLead(tx, se, { name: "Check", source: "OTHER" });
      await expect(tx.$executeRaw`UPDATE leads SET status = 'LOST', "lostAt" = now() WHERE id = ${lead.id}`).rejects.toThrow(/leads_lost_chk/);
    });
  });

  it("follow-ups: scheduling moves a new lead to FOLLOW_UP; overdue counts; closed leads drop off; done can set the next", async () => {
    await inRolledBackTransaction(async (tx) => {
      const se = await sessionUserFor(SE);
      const before = await listDueFollowUps(tx, se);
      const lead = await createLead(tx, se, { name: "Follow me", source: "MESSENGER", followUpAt: inHours(1) });
      expect(lead.status).toBe("FOLLOW_UP");

      await expect(scheduleFollowUp(tx, se, lead.id, { dueAt: inHours(-2) })).rejects.toThrow(/already passed/);

      // An overdue one (written directly: the service refuses past times).
      const overdue = await tx.leadFollowUp.create({ data: { leadId: lead.id, dueAt: inHours(-3), createdById: se.id } });
      const after = await listDueFollowUps(tx, se);
      expect(after.overdue).toBe(before.overdue + 1);
      expect(after.items[0].dueAt <= after.items[after.items.length - 1].dueAt).toBe(true);

      await completeFollowUp(tx, se, overdue.id, { outcome: "Called, will buy Friday", next: { dueAt: inHours(20) } });
      await expect(completeFollowUp(tx, se, overdue.id, {})).rejects.toThrow(/already done/);
      expect((await listDueFollowUps(tx, se)).overdue).toBe(before.overdue);

      await changeLeadStatus(tx, se, lead.id, { status: "LOST", lostReason: "NO_RESPONSE" });
      const closed = await listDueFollowUps(tx, se, { days: 7 });
      expect(closed.items.some((f) => f.lead.id === lead.id)).toBe(false);
    });
  });

  it("a converted lead can't be deleted; others are soft-deleted and audited", async () => {
    await inRolledBackTransaction(async (tx) => {
      const admin = await sessionUserFor(ADMIN);
      const lead = await createLead(tx, admin, { name: "Delete me", source: "OTHER" });
      await deleteLead(tx, admin, lead.id);
      expect((await tx.lead.findUniqueOrThrow({ where: { id: lead.id } })).deletedAt).not.toBeNull();
      expect(await tx.auditLog.count({ where: { entityId: lead.id, action: "lead.delete" } })).toBe(1);

      const converted = await tx.lead.findFirstOrThrow({ where: { status: "CONVERTED" } });
      await expect(deleteLead(tx, admin, converted.id)).rejects.toBeInstanceOf(LeadError);
    });
  });
});

describe("lead → order conversion", () => {
  it("links the order, closes the lead, and a lead converts only once", async () => {
    await inRolledBackTransaction(async (tx) => {
      const se = await sessionUserFor(SE);
      const customer = await tx.customer.findFirstOrThrow({ where: { createdById: se.id, deletedAt: null } });
      const lead = await createLead(tx, se, { name: customer.name, source: "FACEBOOK_AD", campaign: "Test Campaign", followUpAt: inHours(2) });

      const order = await tx.order.create({ data: { orderNo: `AB-TEST-${uniquePhone()}`, customerId: customer.id, leadId: lead.id, createdById: se.id, teamId: se.teamId, total: 2500 } });
      await markLeadConverted(tx, { leadId: lead.id, customerId: customer.id, orderId: order.id, actorId: se.id });

      const converted = await tx.lead.findUniqueOrThrow({ where: { id: lead.id }, include: { order: true } });
      expect(converted).toMatchObject({ status: "CONVERTED", customerId: customer.id });
      expect(converted.order?.id).toBe(order.id);
      expect(await tx.auditLog.count({ where: { entityId: lead.id, action: "lead.convert" } })).toBe(1);
      // Its reminder stops showing.
      expect((await listDueFollowUps(tx, se)).items.some((f) => f.lead.id === lead.id)).toBe(false);

      await expect(markLeadConverted(tx, { leadId: lead.id, customerId: customer.id, orderId: order.id, actorId: se.id })).rejects.toThrow(/already been converted/);
    });
  });

  it("the order route refuses a lead the user can't convert, can't see, or that was already converted", async () => {
    const [se, tl, pos] = await Promise.all([SE, TL, POS].map(sessionUserFor));
    const tlLead = await prisma.lead.findFirstOrThrow({ where: { createdById: tl.id, status: { not: "CONVERTED" }, deletedAt: null } });
    const seConverted = await prisma.lead.findFirstOrThrow({ where: { createdById: se.id, status: "CONVERTED" } });
    const variant = await prisma.productVariant.findFirstOrThrow({ where: { isActive: true } });
    const body = (leadId: string) => ({ leadId, customer: { name: "X", phone: "01799999999" }, items: [{ variantId: variant.id, qty: 1, unitPrice: 1000 }] });
    const post = (b: unknown) => ordersPOST(new NextRequest("http://localhost/api/orders", { method: "POST", body: JSON.stringify(b), headers: { "content-type": "application/json" } }));
    const ordersBefore = await prisma.order.count();

    asSession(se);
    expect((await post(body(tlLead.id))).status).toBe(400);
    expect((await post(body(seConverted.id))).status).toBe(409);

    asSession(pos);
    expect((await post(body(tlLead.id))).status).toBe(403);

    expect(await prisma.order.count()).toBe(ordersBefore);
  });
});

describe("daily quick-entry counts", () => {
  it("merges rows, rejects more bought than leads, replaces the day, and stays in scope", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [se, tl] = await Promise.all([SE, TL].map(sessionUserFor));
      const other = await otherExecutive(tx);
      const day = todayInDhaka();

      expect(mergeDailyRows([
        { source: "MESSENGER", campaign: " Eid  Sale ", leadCount: 3, convertedCount: 1 },
        { source: "MESSENGER", campaign: "eid sale", leadCount: 2, convertedCount: 0 },
        { source: "WHATSAPP", campaign: null, leadCount: 0, convertedCount: 0 },
      ])).toEqual([{ source: "MESSENGER", campaign: "Eid Sale", leadCount: 5, convertedCount: 1 }]);

      await expect(saveDailySheet(tx, se, { userId: se.id, day, rows: [{ source: "MESSENGER", campaign: null, leadCount: 2, convertedCount: 3 }] })).rejects.toThrow(/more converted/);
      await expect(saveDailySheet(tx, se, { userId: tl.id, day, rows: [] })).rejects.toThrow(/can't record/);
      await expect(saveDailySheet(tx, tl, { userId: other.id, day, rows: [] })).rejects.toThrow(/can't record/);

      await saveDailySheet(tx, se, { userId: se.id, day, rows: [{ source: "MESSENGER", campaign: null, leadCount: 7, convertedCount: 2 }] });
      const sheet = await saveDailySheet(tx, tl, { userId: se.id, day, rows: [{ source: "INSTAGRAM", campaign: null, leadCount: 4, convertedCount: 1 }] });
      expect(sheet.rows).toEqual([{ source: "INSTAGRAM", campaign: null, leadCount: 4, convertedCount: 1 }]);
      expect((await getDailySheet(tx, se, se.id, day)).enteredBy?.id).toBe(tl.id);
      expect(await tx.auditLog.count({ where: { entityType: "lead_daily_counts", entityId: `${se.id}:${day}` } })).toBe(2);
    });
  });
});

describe("conversion report", () => {
  it("adds counted leads to recorded ones, per executive, source and campaign, within scope", async () => {
    await inRolledBackTransaction(async (tx) => {
      const [se, tl] = await Promise.all([SE, TL].map(sessionUserFor));
      const other = await otherExecutive(tx);
      const day = todayInDhaka();
      const range = { fromDay: day, toDay: day };
      const base = await getLeadConversionReport(tx, se, range);

      await createLead(tx, se, { name: "A", source: "INSTAGRAM", campaign: "Report Test" });
      const b = await createLead(tx, se, { name: "B", source: "INSTAGRAM", campaign: "report test" });
      await changeLeadStatus(tx, se, b.id, { status: "LOST", lostReason: "PRICE" });
      await createLead(tx, other, { name: "C", source: "INSTAGRAM", campaign: "Report Test" });
      await saveDailySheet(tx, se, { userId: se.id, day, rows: [{ source: "INSTAGRAM", campaign: "Report Test", leadCount: 6, convertedCount: 3 }] });

      const report = await getLeadConversionReport(tx, se, range);
      expect(report.totals.leads).toBe(base.totals.leads + 8);
      expect(report.bySe.map((r) => r.key)).toEqual([se.id]);
      const campaign = report.byCampaign.find((r) => r.label.toLowerCase() === "report test")!;
      expect(campaign).toMatchObject({ recorded: 2, counted: 6, leads: 8, converted: 3, lost: 1, open: 1 });
      expect(campaign.rate).toBeCloseTo(3 / 8);

      // The TL sees the executive's numbers; nobody on the team sees the outsider's.
      const tlReport = await getLeadConversionReport(tx, tl, range);
      expect(tlReport.bySe.some((r) => r.key === se.id)).toBe(true);
      expect(tlReport.bySe.some((r) => r.key === other.id)).toBe(false);
    });
  });

  it("CSV export needs report.export — an executive gets the screen but not the file", async () => {
    asSession(await sessionUserFor(SE));
    expect((await reportGET(new NextRequest("http://localhost/api/leads/report"))).status).toBe(200);
    expect((await reportGET(new NextRequest("http://localhost/api/leads/report?format=csv"))).status).toBe(403);

    asSession(await sessionUserFor(ADMIN));
    const csv = await reportGET(new NextRequest("http://localhost/api/leads/report?format=csv"));
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect((await csv.text()).split("\n")[0]).toMatch(/^Breakdown,Name,/);
  });
});
