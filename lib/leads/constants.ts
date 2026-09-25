// PRD §4.5 — leads. Client- and server-safe (no Prisma import), mirrored
// from the LeadSource / LeadStatus / LeadLostReason enums in schema.prisma.

export const LEAD_SOURCE_VALUES = [
  "FACEBOOK_AD",
  "MESSENGER",
  "WHATSAPP",
  "INSTAGRAM",
  "REFERRAL",
  "REPEAT_CUSTOMER",
  "SHOWROOM_WALK_IN",
  "OTHER",
] as const;
export type LeadSourceValue = (typeof LEAD_SOURCE_VALUES)[number];

export const LEAD_SOURCE_LABELS: Record<LeadSourceValue, string> = {
  FACEBOOK_AD: "Facebook Ad",
  MESSENGER: "Messenger",
  WHATSAPP: "WhatsApp",
  INSTAGRAM: "Instagram",
  REFERRAL: "Referral",
  REPEAT_CUSTOMER: "Repeat customer",
  SHOWROOM_WALK_IN: "Showroom walk-in",
  OTHER: "Other",
};

export const LEAD_STATUS_VALUES = ["NEW", "CONTACTED", "FOLLOW_UP", "NEGOTIATING", "CONVERTED", "LOST"] as const;
export type LeadStatusValue = (typeof LEAD_STATUS_VALUES)[number];

export const LEAD_STATUS_LABELS: Record<LeadStatusValue, string> = {
  NEW: "New",
  CONTACTED: "Contacted",
  FOLLOW_UP: "Follow-up",
  NEGOTIATING: "Negotiating",
  CONVERTED: "Converted",
  LOST: "Lost",
};

/** Still being worked: follow-ups on these leads are live. */
export const OPEN_LEAD_STATUSES = ["NEW", "CONTACTED", "FOLLOW_UP", "NEGOTIATING"] as const satisfies readonly LeadStatusValue[];
export type OpenLeadStatus = (typeof OPEN_LEAD_STATUSES)[number];

export function isOpenLeadStatus(status: LeadStatusValue): status is OpenLeadStatus {
  return (OPEN_LEAD_STATUSES as readonly string[]).includes(status);
}

export const LEAD_LOST_REASON_VALUES = ["PRICE", "SIZE_UNAVAILABLE", "NO_RESPONSE", "BOUGHT_ELSEWHERE", "OTHER"] as const;
export type LeadLostReasonValue = (typeof LEAD_LOST_REASON_VALUES)[number];

export const LEAD_LOST_REASON_LABELS: Record<LeadLostReasonValue, string> = {
  PRICE: "Price",
  SIZE_UNAVAILABLE: "Size unavailable",
  NO_RESPONSE: "No response",
  BOUGHT_ELSEWHERE: "Bought elsewhere",
  OTHER: "Other",
};

/** List filter for the follow-up column. */
export const LEAD_FOLLOW_UP_FILTERS = ["overdue", "today", "upcoming", "none"] as const;
export type LeadFollowUpFilter = (typeof LEAD_FOLLOW_UP_FILTERS)[number];

/** Rows on one day's quick-entry sheet. */
export const MAX_DAILY_COUNT_ROWS = 30;
