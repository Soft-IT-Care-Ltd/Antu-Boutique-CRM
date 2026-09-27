import { CustomerList } from "@/components/customers/customer-list";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";

export default async function CustomersPage() {
  const user = await guardPage("/customers");
  const canCreate = await can(user, "customer.create");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl leading-tight font-semibold tracking-tight md:text-[28px]">Customers</h1>
        <p className="text-sm text-muted-foreground">One person per customer — phone, address, order history.</p>
      </div>
      <CustomerList canCreate={canCreate} />
    </div>
  );
}
