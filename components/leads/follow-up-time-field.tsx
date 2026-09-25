"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { dhakaDayStartOf, utcToDhakaLocal } from "@/lib/leads/dates";

// Quick picks, in Dhaka time, for the times an executive actually uses.
function quickPicks(now = new Date()): { label: string; value: string }[] {
  const inTwoHours = new Date(Math.ceil((now.getTime() + 2 * 3_600_000) / 900_000) * 900_000);
  const tomorrow = utcToDhakaLocal(dhakaDayStartOf(now, 1)).slice(0, 10);
  const today = utcToDhakaLocal(now).slice(0, 10);
  const eveningToday = `${today}T18:00`;
  const picks = [{ label: "In 2 hours", value: utcToDhakaLocal(inTwoHours) }];
  if (eveningToday > utcToDhakaLocal(inTwoHours)) picks.push({ label: "This evening", value: eveningToday });
  picks.push({ label: "Tomorrow 11 am", value: `${tomorrow}T11:00` }, { label: "Tomorrow 6 pm", value: `${tomorrow}T18:00` });
  return picks;
}

/** A follow-up date/time, typed and shown in Dhaka time ("YYYY-MM-DDTHH:mm"). */
export function FollowUpTimeField({ id, value, onChange, required }: { id: string; value: string; onChange: (value: string) => void; required?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <Input id={id} type="datetime-local" value={value} min={utcToDhakaLocal(new Date())} onChange={(e) => onChange(e.target.value)} required={required} />
      <div className="flex flex-wrap gap-1.5">
        {quickPicks().map((p) => (
          <Button key={p.label} type="button" size="xs" variant={value === p.value ? "default" : "outline"} onClick={() => onChange(p.value)}>
            {p.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
