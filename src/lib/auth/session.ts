export type AppSession = {
  userId: string;
  email: string;
} | null;

export async function getAppSession(): Promise<AppSession> {
  // TODO: wire Auth.js / Clerk here
  return null;
}
