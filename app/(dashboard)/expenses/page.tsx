import { z } from "zod";

import { ExpenseList } from "@/components/expenses/expense-list";
import { SectionHeader } from "@/components/finance/section-header";
import { EXPENSE_KIND_FILTER_VALUES } from "@/lib/expenses/constants";
import { listExpenseCategories } from "@/lib/expenses/queries";
import { getExpensesAccess } from "@/lib/finance/page-context";
import { prisma } from "@/lib/prisma";
import { listWalletOptions } from "@/lib/wallets/service";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Dashboard links land here pre-filtered (P4.3).
const filtersSchema = z.object({
  kind: z.enum(EXPENSE_KIND_FILTER_VALUES).optional().catch(undefined),
  from: z.string().regex(DAY).optional().catch(undefined),
  to: z.string().regex(DAY).optional().catch(undefined),
});

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await getExpensesAccess();
  const filters = filtersSchema.parse(await searchParams);
  const [categories, wallets] = await Promise.all([listExpenseCategories(prisma), listWalletOptions(prisma)]);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Expenses" description="Daily expenses by category, fixed vs variable, and the wallet they were paid from." links={access.links} />
      <ExpenseList key={JSON.stringify(filters)} initialFilters={filters} categories={categories} wallets={wallets} canCreate={access.canCreate} canEdit={access.canEdit} canDelete={access.canDelete} />
    </div>
  );
}
