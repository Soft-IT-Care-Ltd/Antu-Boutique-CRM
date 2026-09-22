import { redirect } from "next/navigation";

import { EditRequestsList } from "@/components/orders/edit-requests-list";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";

export default async function OrderEditRequestsPage() {
  const user = await guardPage("/orders");
  if (!(await can(user, "order.edit_after_window"))) redirect("/orders");

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Edit requests</h1>
        <p className="text-sm text-muted-foreground">
          Order edits made after the edit window has closed, waiting on your approval.
        </p>
      </div>
      <EditRequestsList />
    </div>
  );
}
