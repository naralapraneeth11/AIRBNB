import type { Metadata } from "next";
import { configured } from "@/server/config";
import { accountFeatures } from "@/server/accounts/email";
import { SignUp } from "@/components/account";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Create an account" };
export default function SignUpPage() {
  return <SignUp available={configured() && accountFeatures().signup} />;
}
