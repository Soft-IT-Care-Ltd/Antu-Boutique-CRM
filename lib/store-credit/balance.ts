// P3.2 — a customer's store credit, derived from their ledger rows. Never
// stored (PRD §4.11): this function is the only definition of the balance.
// Pure, so the same answer comes out for the customer screen, the POS, the
// spend check and the collection report.
//
// Rows that add credit (ISSUED, RESTORED, a positive ADJUSTED) are lots; a
// lot added while an expiry was set lapses at its expiresAt. Rows that take
// credit (USED, a negative ADJUSTED) draw from the lots available at that
// moment, the one expiring soonest first (never-expiring last), then the
// oldest — so the customer never loses credit they could have spent.
// Whatever is left of a lot when it lapses has expired.

export type CreditRow = { id: string; amountPaisa: number; createdAt: Date; expiresAt: Date | null };

export type Lot = { id: string; createdAt: Date; expiresAt: Date | null; remainingPaisa: number };

export type DerivedCredit = {
  /** What the customer can spend at `asOf`. */
  balancePaisa: number;
  /** Credit still open at `asOf`, soonest-expiring first. */
  lots: Lot[];
  /** Each lot that lapsed (by `asOf`) with credit left on it. */
  expiries: { lotId: string; at: Date; paisa: number }[];
};

const expiryKey = (l: Lot) => (l.expiresAt ? l.expiresAt.getTime() : Number.POSITIVE_INFINITY);

export function deriveStoreCredit(rows: CreditRow[], asOf: Date = new Date()): DerivedCredit {
  const upTo = asOf.getTime();
  const sorted = rows
    .filter((r) => r.createdAt.getTime() <= upTo)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));

  let lots: Lot[] = [];
  const expiries: DerivedCredit["expiries"] = [];
  // Only reachable if a row ever took more than was there (the service
  // refuses that) — kept so the figure still adds up to the ledger's sum.
  let deficitPaisa = 0;

  const lapse = (at: number) => {
    lots = lots.filter((l) => {
      if (l.expiresAt && l.expiresAt.getTime() <= at) {
        if (l.remainingPaisa > 0) expiries.push({ lotId: l.id, at: l.expiresAt, paisa: l.remainingPaisa });
        return false;
      }
      return true;
    });
  };

  for (const row of sorted) {
    lapse(row.createdAt.getTime());
    if (row.amountPaisa > 0) {
      let add = row.amountPaisa;
      const cover = Math.min(add, deficitPaisa);
      deficitPaisa -= cover;
      add -= cover;
      if (add > 0) lots.push({ id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt, remainingPaisa: add });
      continue;
    }
    let take = -row.amountPaisa;
    lots.sort((a, b) => expiryKey(a) - expiryKey(b) || a.createdAt.getTime() - b.createdAt.getTime());
    for (const lot of lots) {
      if (take === 0) break;
      const used = Math.min(lot.remainingPaisa, take);
      lot.remainingPaisa -= used;
      take -= used;
    }
    lots = lots.filter((l) => l.remainingPaisa > 0);
    deficitPaisa += take;
  }
  lapse(upTo);
  lots.sort((a, b) => expiryKey(a) - expiryKey(b) || a.createdAt.getTime() - b.createdAt.getTime());

  return { balancePaisa: lots.reduce((sum, l) => sum + l.remainingPaisa, 0) - deficitPaisa, lots, expiries };
}

/** Credit that lapsed in [from, to). */
export function expiredBetween(derived: DerivedCredit, from: Date, to: Date): number {
  return derived.expiries.filter((e) => e.at >= from && e.at < to).reduce((sum, e) => sum + e.paisa, 0);
}
