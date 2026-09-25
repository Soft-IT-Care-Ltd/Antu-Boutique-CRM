import Link from "next/link";
import { notFound } from "next/navigation";
import { ChevronLeft } from "lucide-react";
import { z } from "zod";

import { LeadDetail } from "@/components/leads/lead-detail";
import { Button } from "@/components/ui/button";
import { guardPage } from "@/lib/auth/guard-page";
import { can } from "@/lib/auth/permissions";
import { listCampaignSuggestions, loadLeadDetail } from "@/lib/leads/queries";
import { prisma } from "@/lib/prisma";

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await guardPage("/leads");
  const { id } = await params;
  if (!z.string().cuid().safeParse(id).success) notFound();

  // Scoped: another executive's lead is simply not found.
  const lead = await loadLeadDetail(prisma, user, id);
  if (!lead) notFound();

  const [canEdit, canDelete, canConvert, campaigns] = await Promise.all([
    can(user, "lead.edit"),
    can(user, "lead.delete"),
    can(user, ["lead.convert", "order.create"], "all"),
    listCampaignSuggestions(prisma, user),
  ]);

  return (
    <div className="flex flex-1 flex-col gap-4 p-4 md:mx-auto md:w-full md:max-w-5xl md:p-6">
      <Button variant="ghost" size="sm" className="w-fit" render={<Link href="/leads" />} nativeButton={false}>
        <ChevronLeft />
        Leads
      </Button>
      <LeadDetail lead={lead} campaigns={campaigns} permissions={{ canEdit, canDelete, canConvert }} />
    </div>
  );
}
