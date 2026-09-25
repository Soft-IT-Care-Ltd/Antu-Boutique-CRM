import { RewardsView } from "@/components/targets/rewards-view";
import { TargetsHeader } from "@/components/targets/targets-header";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { targetPageContext } from "@/lib/targets/page-context";
import { getMonthAwards, listRules } from "@/lib/targets/rewards";

export const dynamic = "force-dynamic";

// PRD §4.13 reward rules (threshold → reward) and the rewards each month
// earned, worked out at month end. Awards are scoped like targets.
export default async function RewardsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/targets");
  const canManage = await can(user, "target.manage");
  const { month, months, level, current } = await targetPageContext(user, searchParams);
  const [rules, awards] = await Promise.all([listRules(prisma, { includeInactive: canManage }), getMonthAwards(prisma, user, level, month)]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <TargetsHeader title="Rewards" description="What hitting a target earns — worked out at the end of each month." month={month} months={months} />
      <RewardsView rules={rules} awards={awards} canManage={canManage} isClosedMonth={month < current} />
    </div>
  );
}
