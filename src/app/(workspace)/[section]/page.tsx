import { notFound, redirect } from "next/navigation";
import { currentContext } from "@/server/auth";
import { configured } from "@/server/config";
import { Workspace } from "@/components/workspace";
export const dynamic = "force-dynamic";
export default async function Page({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (
    ![
      "overview",
      "calendar",
      "inbox",
      "cleaning",
      "properties",
      "automation",
      "insights",
      "settings",
      "activity",
    ].includes(section)
  )
    notFound();
  if (!configured()) redirect("/login?setup=required");
  const ctx = await currentContext();
  if (!ctx) redirect("/login");
  return <Workspace section={section} />;
}
