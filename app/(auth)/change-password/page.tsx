import type { Metadata } from "next";

import { ChangePasswordForm } from "@/components/auth/change-password-form";

export const metadata: Metadata = {
  title: "Change password — Antu Boutique CRM",
};

export default function ChangePasswordPage() {
  return <ChangePasswordForm />;
}
