import { SectionHeader } from "@/components/finance/section-header";
import { ExpenseReportView } from "@/components/reports/finance-reports";
import { monthStartInDhaka } from "@/lib/finance/dates";
import { getExpensesAccess } from "@/lib/finance/page-context";
import { todayInDhaka } from "@/lib/inventory/constants";

export default async function ExpenseReportPage() {
  const access = await getExpensesAccess();
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Expenses" description="Expense report — by category, fixed vs variable, wallet and day." links={access.links} />
      <ExpenseReportView initialFrom={monthStartInDhaka()} initialTo={todayInDhaka()} />
    </div>
  );
}
