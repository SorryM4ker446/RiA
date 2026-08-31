import { redirect } from "next/navigation";
import { connection } from "next/server";
import { isAuthDisabled } from "@/lib/auth/request-user";
import { getSessionUserFromCookies } from "@/lib/auth/session";

export default async function ConversationsLayout({ children }: { children: React.ReactNode }) {
  await connection();
  if (!isAuthDisabled() && !await getSessionUserFromCookies()) redirect("/login");
  return <>{children}</>;
}
