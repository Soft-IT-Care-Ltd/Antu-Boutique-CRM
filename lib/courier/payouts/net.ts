// Courier payout math (Gift Valy CORRECTIONS Round 2 §2.7), pure.
//
//   subtotal       = COD − courier delivery charge
//   COD fee        = fee% of the SUBTOTAL (their real invoices: 2200 − 135 =
//                    2065 → 1% ≈ 21, not 22)
//   net receivable = COD − delivery charge − COD fee
//
// The delivery charge is the courier's actual one when known, else our
// zone + weight estimate — `chargeKnown` says which.

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Their per-parcel fee rounding drifts by a taka or two — beyond this it's a real discrepancy. */
export const PAYOUT_MATCH_TOLERANCE = 2;

export type NetReceivable = { deliveryCharge: number; codFee: number; deduction: number; netReceivable: number; chargeKnown: boolean };

export function computeNetReceivable(args: {
  codAmount: number;
  courierCostActual?: number | null;
  courierCostEstimate?: number | null;
  codFeePercent?: number | null;
}): NetReceivable {
  const cod = round2(Math.max(args.codAmount, 0));
  const actual = args.courierCostActual != null && args.courierCostActual > 0 ? args.courierCostActual : null;
  const estimate = args.courierCostEstimate != null && args.courierCostEstimate > 0 ? args.courierCostEstimate : null;
  const charge = round2(actual ?? estimate ?? 0);
  const feePct = args.codFeePercent ?? 1;
  const codFee = round2((Math.max(cod - charge, 0) * feePct) / 100);
  const deduction = round2(charge + codFee);
  return { deliveryCharge: charge, codFee, deduction, netReceivable: round2(cod - deduction), chargeKnown: actual != null };
}

export const withinTolerance = (a: number, b: number) => Math.abs(round2(a) - round2(b)) <= PAYOUT_MATCH_TOLERANCE;

/** gross = net + delivery charge + COD charge, to the paisa-and-a-bit (2p slack for their rounding). */
export function statementIdentityHolds(s: { grossAmount: number; deliveryCharge: number; codCharge: number; netAmount: number }): boolean {
  return Math.abs(s.grossAmount - (s.netAmount + s.deliveryCharge + s.codCharge)) <= 0.02;
}

/**
 * Fill whichever side of gross − delivery − COD charge = net is missing, from
 * the header figures first and the lines second.
 */
export function completeStatementAmounts(
  header: { grossAmount?: number | null; deliveryCharge?: number | null; codCharge?: number | null; netAmount?: number | null },
  lines: { codAmount: number; deliveryCharge?: number | null; codCharge?: number | null }[],
): { grossAmount: number; deliveryCharge: number; codCharge: number; netAmount: number } {
  const sum = (pick: (l: (typeof lines)[number]) => number | null | undefined) => {
    const values = lines.map(pick).filter((v): v is number => v != null);
    return values.length ? round2(values.reduce((a, b) => a + b, 0)) : null;
  };
  const deliveryCharge = header.deliveryCharge ?? sum((l) => l.deliveryCharge) ?? 0;
  const codCharge = header.codCharge ?? sum((l) => l.codCharge) ?? 0;
  let grossAmount = header.grossAmount ?? sum((l) => l.codAmount);
  let netAmount = header.netAmount ?? null;
  if (grossAmount == null && netAmount != null) grossAmount = round2(netAmount + deliveryCharge + codCharge);
  grossAmount ??= 0;
  netAmount ??= round2(grossAmount - deliveryCharge - codCharge);
  return { grossAmount: round2(grossAmount), deliveryCharge: round2(deliveryCharge), codCharge: round2(codCharge), netAmount: round2(netAmount) };
}
