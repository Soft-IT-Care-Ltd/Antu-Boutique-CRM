import { ExpenseList } from "@/components/expenses/expense-list";
import { SectionHeader } from "@/components/finance/section-header";
import { listExpenseCategories } from "@/lib/expenses/queries";
import { getExpensesAccess } from "@/lib/finance/page-context";
import { prisma } from "@/lib/prisma";
import { listWalletOptions } from "@/lib/wallets/service";

export default async function ExpensesPage() {
  const access = await getExpensesAccess();
  const [categories, wallets] = await Promise.all([listExpenseCategories(prisma), listWalletOptions(prisma)]);
  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <SectionHeader title="Expenses" description="Daily expenses by category, fixed vs variable, and the wallet they were paid from." links={access.links} />
      <ExpenseList categories={categories} wallets={wallets} canCreate={access.canCreate} canEdit={access.canEdit} canDelete={access.canDelete} />
    </div>
  );
}
