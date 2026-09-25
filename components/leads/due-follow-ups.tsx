"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Phone } from "lucide-react";

import { FollowUpTime } from "@/components/leads/lead-badges";
import { CompleteFollowUpDialog } from "@/components/leads/lead-detail";
import { Button } from "@/components/ui/button";
import { LEAD_SOURCE_LABELS } from "@/lib/leads/constants";
import { followUpState } from "@/lib/leads/dates";
import type { DueFollowUp } from "@/lib/leads/types";
import { cn } from "@/lib/utils";

/**
 * Open follow-ups, soonest first; overdue ones in red (PRD §4.5). "Done"
 * records what happened and can set the next one without leaving the list.
 */
export function DueFollowUpList({ items, showOwner, canEdit, emptyText }: { items: DueFollowUp[]; showOwner: boolean; canEdit: boolean; emptyText: string }) {
  const router = useRouter();
  const [completing, setCompleting] = useState<DueFollowUp | null>(null);
  const [doneIds, setDoneIds] = useState<string[]>([]);
  const visible = items.filter((f) => !doneIds.includes(f.id));

  if (visible.length === 0) return <p className="py-6 text-center text-sm text-muted-foreground">{emptyText}</p>;

  return (
    <>
      <ul className="flex flex-col divide-y">
        {visible.map((f) => {
          const overdue = followUpState(f.dueAt) === "overdue";
          return (
            <li key={f.id} className={cn("flex items-start justify-between gap-3 py-2.5", overdue && "-mx-2 rounded-md bg-destructive/5 px-2")}>
              <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                <div className="flex flex-wrap items-center gap-x-2">
                  <Link href={`/leads/${f.lead.id}`} className="font-medium underline-offset-4 hover:underline">
                    {f.lead.name}
                  </Link>
                  <FollowUpTime dueAt={f.dueAt} className="text-xs" />
                </div>
                {f.note || f.lead.interest ? <p className="line-clamp-2 text-muted-foreground">{f.note ?? f.lead.interest}</p> : null}
                <p className="text-xs text-muted-foreground">
                  {LEAD_SOURCE_LABELS[f.lead.source]}
                  {showOwner && f.owner ? ` · ${f.owner.name}` : ""}
                </p>
              </div>
              <div className="flex shrink-0 gap-1">
                {f.lead.phone ? (
                  <Button size="icon-sm" variant="outline" render={<a href={`tel:${f.lead.phone}`} />} nativeButton={false} aria-label={`Call ${f.lead.name}`}>
                    <Phone />
                  </Button>
                ) : null}
                {canEdit ? (
                  <Button size="sm" variant="outline" onClick={() => setCompleting(f)}>
                    <Check />
                    Done
                  </Button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
      {completing ? (
        <CompleteFollowUpDialog
          followUp={completing}
          onClose={() => setCompleting(null)}
          onDone={() => {
            setDoneIds((ids) => [...ids, completing.id]);
            setCompleting(null);
            router.refresh();
          }}
        />
      ) : null}
    </>
  );
}
