import { PrismaClient } from "@prisma/client";
import { SQLITE_POOL_TIMEOUT_SECONDS, sqliteDatasourceUrl } from "@/db/sqlite-url";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    datasourceUrl: sqliteDatasourceUrl(process.env.DATABASE_URL),
    // Interactive transactions use a separate connection-acquisition timeout.
    transactionOptions: { maxWait: SQLITE_POOL_TIMEOUT_SECONDS * 1000 },
    // ORM diagnostics can include query values; handlers report sanitized errors instead.
    log: [],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
