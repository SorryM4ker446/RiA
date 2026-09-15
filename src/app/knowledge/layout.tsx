export default function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  // Access control lives in the API layer: every request is validated against
  // the local application credential before it can read or write workspace data.
  return <>{children}</>;
}
