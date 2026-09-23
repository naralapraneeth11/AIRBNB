import { configured } from "@/server/config";
import { SignIn } from "@/components/sign-in";
export const dynamic = "force-dynamic";
export default function Login() {
  return <SignIn configured={configured()} />;
}
