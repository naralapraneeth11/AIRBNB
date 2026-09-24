export function required(name: string) {
  const v = process.env[name];
  if (!v || /REPLACE_|CHANGE_ME/.test(v))
    throw new Error(`Configuration required: ${name}`);
  return v;
}
export function appUrl() {
  return new URL(required("APP_URL")).origin;
}
export const cookieOptions = () => ({
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict" as const,
  path: "/",
});
export function configured() {
  return ["DATABASE_URL", "ENCRYPTION_KEYS", "AUTH_SECRET", "APP_URL"].every(
    (k) => !!process.env[k] && !/REPLACE_|CHANGE_ME/.test(process.env[k]!),
  );
}
export function providerStatus() {
  return {
    sms: !!process.env.TWILIO_ACCOUNT_SID && !!process.env.TWILIO_AUTH_TOKEN,
    email: !!process.env.RESEND_API_KEY,
    ai: !!process.env.OPENAI_API_KEY,
    push: !!process.env.VAPID_PRIVATE_KEY,
    photos: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    monitoring: !!process.env.SENTRY_DSN,
  };
}
