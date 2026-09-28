import type { Metadata } from "next";
import { configured } from "@/server/config";
import { accountFeatures } from "@/server/accounts/email";
import { ForgotPassword } from "@/components/account";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Reset your password" };
export default function ForgotPage() {
  return <ForgotPassword available={configured() && accountFeatures().reset} />;
}
