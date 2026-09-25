import { NextResponse } from "next/server";

import { requirePermission } from "@/lib/auth/require-permission";
import { LEAD_VIEW_PERMISSIONS } from "@/lib/leads/http";
import { listCampaignSuggestions, listLeadPeople } from "@/lib/leads/queries";
import { prisma } from "@/lib/prisma";

// Feeds the leads screens' "executive" pickers and the campaign
// suggestions — scoped exactly like the lead list, so an executive only
// ever gets themself back.
export async function GET() {
  const guard = await requirePermission(LEAD_VIEW_PERMISSIONS);
  if (!guard.ok) return guard.response;
  const [people, campaigns] = await Promise.all([listLeadPeople(prisma, guard.user), listCampaignSuggestions(prisma, guard.user)]);
  return NextResponse.json({ people, campaigns });
}
