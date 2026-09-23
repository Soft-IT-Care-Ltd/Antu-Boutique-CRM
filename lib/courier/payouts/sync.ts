import "server-only";

import { requireEnabledSteadfast } from "@/lib/courier/integration";
import { parsePayoutDetail, parsePayoutList, type ParsedPayout } from "@/lib/courier/payouts/parse";
import { ingestCourierStatement } from "@/lib/courier/reconcile";
import * as steadfast from "@/lib/courier/steadfast/client";
import { withTx, type Db } from "@/lib/db/tx";

// ============ Steadfast payouts sync (Gift Valy Round 2 §2.1 / §2.7) ============
//
// GET /payments is oldest-first, 10 a page, with no paging metadata and an
// empty list past the end. New payouts land on the TAIL, so instead of
// crawling 60+ pages every run we resume from the remembered tail page,
// gallop forward to the first empty page, bisect the exact tail, then walk
// back until payouts predate our first Steadfast shipment (the merchant
// account is older than this software — earlier payouts are money this
// system never saw). Each payout's detail (its consignments) is fetched at
// most once, a few per run, and ingested in its own transaction.

/** Rides the 15-minute status cron, but only runs when the last payouts sync is at least this old. */
export const PAYOUTS_SYNC_MIN_GAP_MS = 60 * 60 * 1000;
const MAX_PAGE_PROBES_PER_RUN = 40;
const DETAIL_FETCHES_PER_RUN = 10;
const ANCHOR_SLACK_MS = 3 * 24 * 60 * 60 * 1000;

export type PayoutsSyncSummary = {
  ok: true;
  payouts: number;
  created: number;
  paidTransitions: number;
  settled: number;
  codRecorded: number;
  discrepancies: number;
  unmatched: number;
  completed: number;
  pageProbes: number;
  detailsFetched: number;
  note?: string;
  errors: { reference: string | null; error: string }[];
};

export async function runSteadfastPayoutsSync(db: Db, opts: { actorId?: string | null; delayMs?: number } = {}): Promise<PayoutsSyncSummary> {
  const { integration, creds, courierId } = await requireEnabledSteadfast(db);
  const delayMs = opts.delayMs ?? 150;
  const pause = () => (delayMs > 0 ? new Promise((r) => setTimeout(r, delayMs)) : Promise.resolve());
  const summary: PayoutsSyncSummary = {
    ok: true,
    payouts: 0,
    created: 0,
    paidTransitions: 0,
    settled: 0,
    codRecorded: 0,
    discrepancies: 0,
    unmatched: 0,
    completed: 0,
    pageProbes: 0,
    detailsFetched: 0,
    errors: [],
  };

  const first = await db.shipment.aggregate({ _min: { bookedAt: true }, where: { courierId, consignmentId: { not: null } } });
  if (!first._min.bookedAt) {
    summary.note = "No Steadfast shipments yet — nothing to reconcile";
    await db.courierIntegration.update({ where: { id: integration.id }, data: { lastPaymentsSyncAt: new Date() } });
    return summary;
  }
  const anchor = new Date(first._min.bookedAt.getTime() - ANCHOR_SLACK_MS);

  const pages = new Map<number, ParsedPayout[]>();
  const getPage = async (page: number): Promise<ParsedPayout[]> => {
    const cached = pages.get(page);
    if (cached) return cached;
    summary.pageProbes += 1;
    const batch = parsePayoutList(await steadfast.getPayments(creds, page));
    pages.set(page, batch);
    await pause();
    return batch;
  };

  const payouts: ParsedPayout[] = [];
  let tail = integration.paymentsLastPage;
  try {
    let lo = Math.max(1, integration.paymentsLastPage);
    while (lo > 1 && (await getPage(lo)).length === 0) lo = Math.max(1, Math.floor(lo / 2));
    if ((await getPage(lo)).length > 0) {
      let step = 1;
      let hi: number | null = null;
      while (summary.pageProbes < MAX_PAGE_PROBES_PER_RUN) {
        const probe = lo + step;
        if ((await getPage(probe)).length > 0) {
          lo = probe;
          step *= 2;
        } else {
          hi = probe;
          break;
        }
      }
      if (hi !== null) {
        while (hi - lo > 1) {
          const mid = Math.floor((lo + hi) / 2);
          if ((await getPage(mid)).length > 0) lo = mid;
          else hi = mid;
        }
      }
      tail = lo;
      for (let p = tail; p >= 1; p--) {
        const batch = await getPage(p);
        if (batch.length === 0) break;
        payouts.unshift(...batch.filter((x) => x.date == null || x.date >= anchor));
        if (batch[0].date && batch[0].date < anchor) break;
      }
    }
  } catch (err) {
    summary.errors.push({ reference: null, error: err instanceof Error ? err.message : "GET /payments failed" });
  }
  summary.payouts = payouts.length;

  for (const payout of payouts) {
    try {
      const existing = await db.courierStatement.findUnique({
        where: { courierId_reference: { courierId, reference: payout.reference } },
        select: { status: true, _count: { select: { lines: true } } },
      });
      let lines = null;
      let detailRaw: unknown = undefined;
      const wantsDetail = !existing || existing._count.lines === 0;
      if (wantsDetail && summary.detailsFetched < DETAIL_FETCHES_PER_RUN) {
        summary.detailsFetched += 1;
        detailRaw = await steadfast.getPaymentDetail(creds, payout.detailId);
        const detail = parsePayoutDetail(detailRaw);
        lines = detail.consignments.map((c) => ({ consignmentId: c.consignmentId, invoice: c.invoice, codAmount: c.codAmount, deliveryCharge: c.deliveryCharge, raw: c.raw }));
        // The detail's own figures are usually fuller than the list row.
        if (detail.payout?.reference === payout.reference) {
          for (const key of ["grossAmount", "deliveryCharge", "codCharge", "netAmount", "date"] as const) {
            if (detail.payout[key] != null) (payout as Record<string, unknown>)[key] = detail.payout[key];
          }
        }
        await pause();
      }
      const outcome = await withTx(db, (tx) =>
        ingestCourierStatement(
          tx,
          {
            courierId,
            source: "STEADFAST_API",
            reference: payout.reference,
            status: payout.status,
            statementDate: payout.date ?? new Date(),
            grossAmount: payout.grossAmount,
            deliveryCharge: payout.deliveryCharge,
            codCharge: payout.codCharge,
            netAmount: payout.netAmount,
            rawPayload: payout.raw,
            rawDetailPayload: detailRaw,
            lines,
          },
          opts.actorId ?? null,
        ),
      );
      if (outcome.created) summary.created += 1;
      if (outcome.becamePaid) summary.paidTransitions += 1;
      summary.settled += outcome.settled;
      summary.codRecorded = Math.round((summary.codRecorded + outcome.codRecorded) * 100) / 100;
      summary.discrepancies += outcome.discrepancies;
      summary.unmatched += outcome.unmatched;
      summary.completed += outcome.completed;
    } catch (err) {
      summary.errors.push({ reference: payout.reference, error: err instanceof Error ? err.message : "payout ingest failed" });
    }
  }

  await db.courierIntegration.update({ where: { id: integration.id }, data: { lastPaymentsSyncAt: new Date(), paymentsLastPage: tail } });
  return summary;
}
