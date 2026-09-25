import type { LeadLostReasonValue, LeadSourceValue, LeadStatusValue } from "@/lib/leads/constants";

export type LeadPerson = { id: string; name: string };

export type LeadListItem = {
  id: string;
  name: string;
  phone: string | null;
  source: LeadSourceValue;
  campaign: string | null;
  interest: string | null;
  status: LeadStatusValue;
  lostReason: LeadLostReasonValue | null;
  /** Earliest open follow-up, if any (ISO). */
  nextFollowUpAt: string | null;
  openFollowUps: number;
  owner: LeadPerson | null;
  customer: { id: string; name: string } | null;
  order: { id: string; orderNo: string } | null;
  createdAt: string;
};

export type LeadFollowUpView = {
  id: string;
  dueAt: string;
  note: string | null;
  completedAt: string | null;
  outcome: string | null;
  createdBy: LeadPerson | null;
  completedBy: LeadPerson | null;
};

export type LeadDetail = LeadListItem & {
  notes: string | null;
  lostNote: string | null;
  lostAt: string | null;
  convertedAt: string | null;
  updatedAt: string;
  followUps: LeadFollowUpView[];
};

/** One open reminder on the "due today" list. */
export type DueFollowUp = {
  id: string;
  dueAt: string;
  note: string | null;
  lead: { id: string; name: string; phone: string | null; status: LeadStatusValue; source: LeadSourceValue; interest: string | null };
  owner: LeadPerson | null;
};

export type LeadStatusCounts = Record<LeadStatusValue, number>;

export type DailyCountRow = {
  source: LeadSourceValue;
  campaign: string | null;
  leadCount: number;
  convertedCount: number;
};

/** One person's quick-entry sheet for one day. */
export type DailyCountSheet = {
  userId: string;
  day: string;
  rows: DailyCountRow[];
  updatedAt: string | null;
  enteredBy: LeadPerson | null;
};

/** A saved day in the history list. */
export type DailyCountDay = {
  userId: string;
  userName: string;
  day: string;
  leadCount: number;
  convertedCount: number;
  rows: DailyCountRow[];
};

export type ConversionRow = {
  key: string;
  label: string;
  /** Leads recorded one by one. */
  recorded: number;
  /** Leads from the daily quick-entry counts. */
  counted: number;
  leads: number;
  converted: number;
  lost: number;
  open: number;
  /** converted ÷ leads, 0–1; null with no leads. */
  rate: number | null;
  /** Total of the (not cancelled) orders the recorded leads converted into, in taka as a string. */
  convertedValue: string;
};

export type LeadConversionReport = {
  fromDay: string;
  toDay: string;
  totals: ConversionRow;
  bySe: ConversionRow[];
  bySource: ConversionRow[];
  byCampaign: ConversionRow[];
  lostReasons: { reason: LeadLostReasonValue; count: number }[];
};
