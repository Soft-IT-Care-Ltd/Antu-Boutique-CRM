// JSON shapes the targets screens and API share. Money is a decimal string
// (fromPaisa), rates and progress are 0–1 fractions.

import type { LeaderboardSort, RewardMetricValue, RewardScopeValue } from "@/lib/targets/constants";

export type StatsView = {
  salesValue: string;
  orderCount: number;
  deliveredValue: string;
  delivered: number;
  returned: number;
  inProgress: number;
  deliveredRate: number | null;
};

export type TargetGoal = { id: string; orderCount: number | null; orderValue: string | null; note: string | null };

export type Progress = {
  target: TargetGoal | null;
  stats: StatsView;
  /** Share of the value target reached; null without one. */
  valueProgress: number | null;
  countProgress: number | null;
};

export type PersonProgress = Progress & { userId: string; name: string; teamId: string | null; teamName: string | null };
export type TeamProgress = Progress & { teamId: string; name: string };

export type TargetBoard = {
  month: string;
  daysLeft: number;
  daysInMonth: number;
  /** Its rewards have been worked out, so its targets no longer change. */
  locked: boolean;
  people: PersonProgress[];
  teams: TeamProgress[];
};

export type LeaderboardRow = {
  rank: number;
  userId: string;
  name: string;
  teamName: string | null;
  stats: StatsView;
  valueProgress: number | null;
  isMe: boolean;
};

export type TeamLeaderboardRow = { rank: number; teamId: string; name: string; stats: StatsView; valueProgress: number | null };

export type Leaderboard = {
  month: string;
  sort: LeaderboardSort;
  /** Everyone ranked — rows may be fewer, cut to what this user can see. */
  ranked: number;
  rows: LeaderboardRow[];
  teams: TeamLeaderboardRow[];
};

export type RewardRuleView = {
  id: string;
  name: string;
  scope: RewardScopeValue;
  metric: RewardMetricValue;
  threshold: string;
  minDeliveredRate: number | null;
  rewardAmount: string | null;
  rewardNote: string | null;
  isActive: boolean;
};

export type AwardView = {
  id: string | null;
  ruleId: string | null;
  ruleName: string;
  scope: RewardScopeValue;
  metric: RewardMetricValue;
  threshold: string;
  subjectName: string;
  userId: string | null;
  teamId: string | null;
  achieved: string;
  salesValue: string;
  orderCount: number;
  deliveredRate: number | null;
  rewardAmount: string | null;
  rewardNote: string | null;
};

export type MonthAwards = {
  month: string;
  /** null = not worked out yet (a preview when `preview` is true). */
  evaluatedAt: string | null;
  evaluatedBy: string | null;
  preview: boolean;
  awards: AwardView[];
};

export type TargetPerson = { id: string; name: string; teamName: string | null };
export type TargetTeam = { id: string; name: string };
