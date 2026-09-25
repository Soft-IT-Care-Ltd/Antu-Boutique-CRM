import { LEAD_STATUS_LABELS, type LeadStatusValue } from "@/lib/leads/constants";

// PRD §4.5 funnel: NEW → CONTACTED → FOLLOW_UP → NEGOTIATING → CONVERTED | LOST.
//
// A lead can move freely between the open stages (a customer who goes
// quiet mid-negotiation goes back to FOLLOW_UP), be marked LOST from any of
// them, and be reopened from LOST. CONVERTED is final and is never picked
// by hand: it is set only when the lead's order is placed, so every
// converted lead has an order behind it.

/** Why a status move is refused, or null when it is allowed. */
export function leadStatusMoveError(from: LeadStatusValue, to: LeadStatusValue): string | null {
  if (from === to) return `This lead is already ${LEAD_STATUS_LABELS[to]}.`;
  if (from === "CONVERTED") return "A converted lead is closed — its order carries on from here.";
  if (to === "CONVERTED") return "A lead becomes Converted when its order is placed — use Convert to order.";
  return null;
}

/** Scheduling a follow-up on a lead nobody has pinned down yet moves it to FOLLOW_UP. */
export function statusAfterScheduling(status: LeadStatusValue): LeadStatusValue {
  return status === "NEW" || status === "CONTACTED" ? "FOLLOW_UP" : status;
}

/** A lead can be turned into an order unless it already was. A lost lead that comes back can be converted directly. */
export function leadConvertError(status: LeadStatusValue): string | null {
  return status === "CONVERTED" ? "This lead has already been converted to an order." : null;
}
