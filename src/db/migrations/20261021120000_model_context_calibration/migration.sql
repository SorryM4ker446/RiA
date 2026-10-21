CREATE TABLE "model_context_calibrations" (
    "modelKey" TEXT NOT NULL PRIMARY KEY,
    "samples" TEXT NOT NULL DEFAULT '[]',
    "updatedAt" DATETIME NOT NULL
);
