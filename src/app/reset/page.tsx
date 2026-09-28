import type { Metadata } from "next";
import { configured } from "@/server/config";
import { accountFeatures } from "@/server/accounts/email";
import { ResetPassword } from "@/components/account";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Choose a new password",
  referrer: "no-referrer",
};
export default function ResetPage() {
  return <ResetPassword available={configured() && accountFeatures().reset} />;
}
