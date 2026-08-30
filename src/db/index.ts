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
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}
