import { CalendarCheck } from "lucide-react";

import { PlaceholderPage } from "@/components/app-shell/placeholder-page";
import { guardPage } from "@/lib/auth/guard-page";

export default async function AttendancePage() {
  await guardPage("/attendance");
  return (
    <PlaceholderPage
      title="Attendance"
      description="Check-in/out, leave requests and the monthly attendance report."
      icon={CalendarCheck}
      phase="Phase 4"
    />
  );
}
