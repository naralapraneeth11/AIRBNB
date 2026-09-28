import type { Metadata } from "next";
import { configured } from "@/server/config";
import { accountFeatures } from "@/server/accounts/email";
import { VerifyEmail } from "@/components/account";
export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Confirm your email",
  referrer: "no-referrer",
};
export default function VerifyPage() {
  return <VerifyEmail available={configured() && accountFeatures().signup} />;
}
