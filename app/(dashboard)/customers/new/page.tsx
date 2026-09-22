import { redirect } from "next/navigation";

import { CustomerForm } from "@/components/customers/customer-form";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";

export default async function NewCustomerPage() {
  const user = await guardPage("/customers");
  if (!(await can(user, "customer.create"))) redirect("/customers");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-2xl md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">New customer</h1>
        <p className="text-sm text-muted-foreground">One person, one phone — no payer/recipient split.</p>
      </div>
      <CustomerForm />
    </div>
  );
}
