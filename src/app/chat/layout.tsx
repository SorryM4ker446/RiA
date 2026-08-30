import { redirect } from "next/navigation";
import { connection } from "next/server";
import { isAuthDisabled } from "@/lib/auth/request-user";
import { getSessionUserFromCookies } from "@/lib/auth/session";

export default async function ChatLayout({ children }: { children: React.ReactNode }) {
  await connection();
  if (!isAuthDisabled()) {
    const user = await getSessionUserFromCookies();
    if (!user) redirect("/login");
  }
  return <>{children}</>;
}
