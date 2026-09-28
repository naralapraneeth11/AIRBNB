import { configured } from "@/server/config";
import { accountFeatures } from "@/server/accounts/email";
import { SignIn } from "@/components/sign-in";
export const dynamic = "force-dynamic";
export default function Login() {
  return <SignIn configured={configured()} features={accountFeatures()} />;
}
