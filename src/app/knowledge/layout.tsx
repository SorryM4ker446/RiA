import { redirect } from "next/navigation";
import { isAuthDisabled } from "@/lib/auth/request-user";
import { getSessionUserFromCookies } from "@/lib/auth/session";

export default async function KnowledgeLayout({ children }: { children: React.ReactNode }) {
  if (!isAuthDisabled()) {
    const user = await getSessionUserFromCookies();
    if (!user) redirect("/login");
  }
  return <>{children}</>;
}
