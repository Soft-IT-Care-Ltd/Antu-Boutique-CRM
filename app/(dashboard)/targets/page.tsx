import { TargetBoardView } from "@/components/targets/target-board";
import { TargetsHeader } from "@/components/targets/targets-header";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { targetPageContext } from "@/lib/targets/page-context";
import { getTargetBoard, listTargetSubjects } from "@/lib/targets/service";

export const dynamic = "force-dynamic";

// PRD §4.13 — monthly targets per person and per team with live progress,
// scoped by target.view_all / _team / _own.
export default async function TargetsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await guardPage("/targets");
  const canManage = await can(user, "target.manage");
  const { month, months, level } = await targetPageContext(user, searchParams, { ahead: canManage ? 2 : 0 });
  const [board, subjects] = await Promise.all([getTargetBoard(prisma, user, level, month), canManage ? listTargetSubjects(prisma) : Promise.resolve({ people: [], teams: [] })]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <TargetsHeader title="Targets" description="This month's goals and how far along everyone is — live from the orders." month={month} months={months} />
      <TargetBoardView board={board} meId={user.id} canManage={canManage} people={subjects.people} teams={subjects.teams} />
    </div>
  );
}
