import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Worker } from "node:worker_threads";
import { db } from "@/db";
import { scheduleDocumentIndexing } from "@/lib/documents/auto-index";
import { indexDocument } from "@/lib/documents/store";
import { documentPagesSchema, type DocumentPage } from "@/lib/documents/types";
import { localCacheDirectory } from "@/lib/local/data-directory";
import { ApiError } from "@/lib/server/api-error";
import { t, tf } from "@/lib/locale";
import { runBackgroundDataOperation } from "@/lib/server/data-operations";
import { DOCUMENT_OCR_WORKER } from "./worker";

/*
 * Reads the scanned pages of imported PDFs in the background.
 *
 * An import keeps what the PDF already had as text and records the pages that
 * still need reading, with the PDF itself kept in the cache folder. Pages are
 * read one at a time and each page's text is saved as soon as it is read, so a
 * restart carries on where it stopped. Once every page is read, the text goes
 * into the document in one update, the keyword index follows, and the vectors
 * are built as for any other change; the kept PDF is then removed.
 *
 * A job belongs to one version of its document: if the document is deleted or
 * imported again meanwhile, the job is dropped rather than writing old text over
 * the new version. One job runs at a time.
 */

/**
 * English first: loaded as "chi_sim+eng", Tesseract.js 7 never loads the English
 * model and logs a garbled language name, while "eng+chi_sim" reads both English
 * and Chinese pages correctly.
 */
export const OCR_LANGUAGES = "eng+chi_sim";
/** Render at about 200 dpi (PDF units are 1/72 inch), at most 12 megapixels a page. */
const RENDER_SCALE = 200 / 72;
const MAX_PIXELS = 12_000_000;
/** How long one page may take to render and read before the job stops as failed. */
const PAGE_TIMEOUT_MS = 180_000;

export type OcrStatus = "pending" | "running" | "failed" | "done";
type Results = Record<string, string>;

const runtimeRequire = process.getBuiltinModule("module").createRequire(join(/* turbopackIgnore: true */ process.cwd(), "package.json"));
const state = globalThis as typeof globalThis & { documentOcr?: { running: Promise<void> | null; again: boolean; worker: Worker | null; documentId: string | null; files?: Promise<void> } };
const work = state.documentOcr ??= { running: null, again: false, worker: null, documentId: null };

/**
 * A job row and its kept PDF change together, one change at a time: an import writes
 * the PDF and then records the job, so a sweep or a finishing run in between must not
 * take the new PDF for a leftover.
 */
function withKeptFiles<T>(change: () => Promise<T>): Promise<T> {
  const next = (work.files ?? Promise.resolve()).then(change);
  work.files = next.then(() => undefined, () => undefined);
  return next;
}

const ocrRoot = () => join(localCacheDirectory("Document OCR"), "ocr");
export const ocrSourcePath = (documentId: string) => join(ocrRoot(), `${documentId}.pdf`);
export const sourceDigest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/**
 * Tesseract.js reads every language from one folder; the bundled languages ship
 * in a package each, so they are copied together once into the cache.
 */
async function languageDirectory() {
  const directory = join(ocrRoot(), "languages");
  await mkdir(directory, { recursive: true });
  for (const language of OCR_LANGUAGES.split("+")) {
    const source = join(dirname(runtimeRequire.resolve(`@tesseract.js-data/${language}/package.json`)), "4.0.0_best_int", `${language}.traineddata.gz`);
    const target = join(directory, `${language}.traineddata.gz`);
    const [from, to] = await Promise.all([stat(source), stat(target).catch(() => null)]);
    if (to?.size !== from.size) {
      const partial = `${target}.${process.pid}.partial`;
      await copyFile(source, partial);
      await rename(partial, target);
    }
  }
  return directory;
}

/**
 * Tesseract separates every Chinese character with a space; those spaces go,
 * while the ones between Latin words and around mixed text stay.
 */
export function cleanOcrText(text: string) {
  const wide = "\\p{Script=Han}\\u3000-\\u303f\\uff00-\\uffef";
  return text
    .replace(new RegExp(`(?<=[${wide}])[ \\t]+(?=[${wide}])`, "gu"), "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The pages as they read once the recognized text replaces the scanned ones. A page
 * where nothing was recognized keeps the little text it had.
 */
export function withOcrText(pages: DocumentPage[], results: Results): DocumentPage[] {
  return pages.map(page => {
    const key = String(page.pageNumber);
    return page.pageNumber !== null && Object.hasOwn(results, key) && results[key].trim() ? { ...page, text: results[key] } : page;
  });
}

/** Text an earlier import of the very same PDF already read, so it is not read twice. */
export async function reusableOcrText(sourceHash: string): Promise<Results | null> {
  const job = await db.documentOcr.findFirst({ where: { sourceHash, status: "done" }, orderBy: { updatedAt: "desc" } });
  return job ? job.results as Results : null;
}

/**
 * Records the pages a just-saved document still needs read, keeps the PDF for it,
 * and starts reading. The same file already queued for this version carries on
 * from where it is rather than starting over.
 */
export async function queueDocumentOcr(input: { documentId: string; contentHash: string; sourceHash: string; pages: number[]; bytes: Uint8Array; results?: Results }) {
  await withKeptFiles(async () => {
    const existing = await db.documentOcr.findUnique({ where: { documentId: input.documentId } });
    // The same file for the same version carries on from the pages already read. After a failure,
    // importing it again is how a missing kept PDF comes back, so the reading starts again too.
    const sameWork = existing && existing.sourceHash === input.sourceHash && existing.contentHash === input.contentHash && existing.status !== "done";
    const path = ocrSourcePath(input.documentId);
    await mkdir(dirname(path), { recursive: true });
    const partial = `${path}.${process.pid}.partial`;
    await writeFile(partial, input.bytes);
    await rename(partial, path);
    if (!sameWork) {
      const data = { sourceHash: input.sourceHash, contentHash: input.contentHash, pages: input.pages, results: input.results ?? {}, status: "pending", error: null };
      await db.documentOcr.upsert({ where: { documentId: input.documentId }, create: { documentId: input.documentId, ...data }, update: data });
    } else if (existing.status === "failed") {
      await db.documentOcr.update({ where: { id: existing.id }, data: { status: "pending", error: null } });
    }
  });
  scheduleDocumentOcr();
}

/** A document saved with all its text needs no reading: any job it had and its kept PDF go. */
export async function clearDocumentOcr(documentId: string) {
  if (work.documentId === documentId) work.worker?.terminate().catch(() => {});
  await withKeptFiles(async () => {
    await db.documentOcr.deleteMany({ where: { documentId, NOT: { status: "done" } } });
    await rm(ocrSourcePath(documentId), { force: true });
  });
}

/** Tries a failed job again from the pages it has not read yet. */
export async function retryDocumentOcr(documentId: string) {
  const job = await db.documentOcr.findUnique({ where: { documentId } });
  if (!job || job.status !== "failed") throw new ApiError({ code: "CONFLICT", message: t("server.documents.ocrNothingToRetry") });
  await db.documentOcr.update({ where: { documentId }, data: { status: "pending", error: null } });
  scheduleDocumentOcr();
}

export type DocumentOcrProgress = { status: OcrStatus; done: number; total: number; error: string | null };
/** How far each listed document's reading has got; documents read in full are left out. */
export async function documentOcrProgress(documentIds: string[]): Promise<Map<string, DocumentOcrProgress>> {
  const jobs = await db.documentOcr.findMany({ where: { documentId: { in: documentIds }, NOT: { status: "done" } } });
  return new Map(jobs.map(job => {
    const pages = job.pages as number[], results = job.results as Results;
    return [job.documentId, { status: job.status as OcrStatus, done: pages.filter(page => Object.hasOwn(results, String(page))).length, total: pages.length, error: job.error }];
  }));
}

/** Starts the reading if it is not running; a request during a run gets one more pass. */
export function scheduleDocumentOcr() {
  if (work.running) { work.again = true; return; }
  work.running = (async () => {
    try {
      do { work.again = false; await runPending(); } while (work.again);
    } catch (error) {
      try { console.error("documents.ocr.failed", error instanceof Error ? error.message : String(error)); } catch { /* already harmless */ }
    } finally { work.running = null; }
  })();
}
export const documentOcrSettled = () => work.running ?? Promise.resolve();
export const documentOcrRunning = () => Boolean(work.running);

/**
 * Picks up pages a restart left unread, and clears kept PDFs a restore or a crash
 * left without a job; a failed job waits for a retry instead.
 */
export async function resumeDocumentOcr() {
  if (work.running) return;
  if (await db.documentOcr.count({ where: { status: { in: ["pending", "running"] } } }) || (await keptSourceIds()).length) scheduleDocumentOcr();
}

const keptSourceIds = async () => (await readdir(ocrRoot()).catch(() => [] as string[])).filter(name => name.endsWith(".pdf")).map(name => name.slice(0, -4));

async function runPending() {
  await removeOrphanedSources();
  for (;;) {
    const job = await db.documentOcr.findFirst({ where: { status: { in: ["pending", "running"] } }, orderBy: { createdAt: "asc" } });
    if (!job) return;
    await runJob(job);
  }
}

/** Kept PDFs whose job is finished or gone: after a restore, a deletion, or a crash between steps. */
function removeOrphanedSources() {
  return withKeptFiles(async () => {
    const ids = await keptSourceIds();
    if (!ids.length) return;
    const live = new Set((await db.documentOcr.findMany({ where: { documentId: { in: ids }, NOT: { status: "done" } }, select: { documentId: true } })).map(job => job.documentId));
    for (const id of ids) if (!live.has(id)) await rm(ocrSourcePath(id), { force: true });
  });
}

type Job = NonNullable<Awaited<ReturnType<typeof db.documentOcr.findFirst>>>;
async function runJob(job: Job) {
  // Only while the row is still this job: an import of the document meanwhile replaces it,
  // with a new version and a new PDF that must not be dropped along with the old run.
  const mine = { id: job.id, contentHash: job.contentHash, sourceHash: job.sourceHash };
  const drop = () => withKeptFiles(async () => {
    const { count } = await db.documentOcr.deleteMany({ where: mine });
    if (count) await rm(ocrSourcePath(job.documentId), { force: true });
  });
  const fail = (error: string) => db.documentOcr.updateMany({ where: mine, data: { status: "failed", error: error.slice(0, 300) } });
  const document = await db.knowledgeDocument.findUnique({ where: { id: job.documentId } });
  if (!document || document.contentHash !== job.contentHash) { await drop(); return; }
  const pages = job.pages as number[];
  const results: Results = { ...(job.results as Results) };
  const remaining = pages.filter(page => !Object.hasOwn(results, String(page)));

  if (remaining.length) {
    let bytes: Buffer;
    try { bytes = await readFile(ocrSourcePath(job.documentId)); }
    catch { await fail(t("server.documents.ocrSourceMissing")); return; }
    if (sourceDigest(bytes) !== job.sourceHash) { await fail(t("server.documents.ocrSourceChanged")); return; }
    await db.documentOcr.updateMany({ where: mine, data: { status: "running", error: null } });
    const outcome = await readPages(job, bytes, remaining, async (page, text) => {
      results[String(page)] = cleanOcrText(text);
      // Saved page by page; a job dropped meanwhile (document deleted or imported again) stops the reading.
      const saved = await db.documentOcr.updateMany({ where: mine, data: { results } });
      return saved.count === 1;
    });
    if (outcome === "dropped") { await drop(); return; }
    if (outcome !== "done") { await fail(outcome); return; }
  }

  // Every page is read: the text goes into the document, as one new version.
  try {
    const pagesRead = withOcrText(documentPagesSchema.parse(document.pages), results);
    if (!pagesRead.some(page => page.text.trim())) { await fail(t("server.documents.ocrNoText")); return; }
    await runBackgroundDataOperation(() => indexDocument(
      { filename: document.filename, collection: document.collection, format: document.format, byteSize: document.byteSize, pages: pagesRead },
      { id: document.id, contentHash: job.contentHash }, undefined, { textPending: false },
    ));
  } catch (error) {
    if (error instanceof ApiError && (error.code === "CONFLICT" || error.code === "NOT_FOUND")) { await drop(); return; }
    await fail(error instanceof Error ? error.message : String(error));
    return;
  }
  await withKeptFiles(async () => {
    const { count } = await db.documentOcr.updateMany({ where: mine, data: { status: "done", results, error: null } });
    if (count) await rm(ocrSourcePath(job.documentId), { force: true });
  });
  scheduleDocumentIndexing();
}

/** Reads the given pages in a worker; "done", "dropped" when the job went away, or why it failed. */
async function readPages(job: Job, bytes: Buffer, pages: number[], onPage: (page: number, text: string) => Promise<boolean>): Promise<string> {
  const worker = new Worker(DOCUMENT_OCR_WORKER, {
    eval: true, execArgv: [], env: { DISABLE_SYSTEM_FONTS_LOAD: "1" }, stdout: true, stderr: true,
    workerData: {
      bytes, pages, languages: OCR_LANGUAGES, scale: RENDER_SCALE, maxPixels: MAX_PIXELS, langPath: await languageDirectory(),
      pdfPath: runtimeRequire.resolve("pdfjs-dist/legacy/build/pdf.mjs"), pdfWorkerPath: runtimeRequire.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
      canvasPath: runtimeRequire.resolve("@napi-rs/canvas"), tesseractPath: runtimeRequire.resolve("tesseract.js"),
    },
  });
  worker.stdout?.resume();
  worker.stderr?.resume();
  work.worker = worker; work.documentId = job.documentId;
  try {
    return await new Promise<string>(resolve => {
      let settled = false, chain = Promise.resolve();
      const finish = (outcome: string) => { if (!settled) { settled = true; clearTimeout(timer); resolve(outcome); } };
      let timer = setTimeout(() => finish(t("server.documents.ocrPageTimeout")), PAGE_TIMEOUT_MS);
      worker.on("message", message => {
        chain = chain.then(async () => {
          if (settled) return;
          if (message?.error) { finish(tf("server.documents.ocrReadFailed", { reason: String(message.error) })); return; }
          if (message?.done) { finish("done"); return; }
          if (typeof message?.page !== "number" || typeof message.text !== "string") return;
          clearTimeout(timer);
          timer = setTimeout(() => finish(t("server.documents.ocrPageTimeout")), PAGE_TIMEOUT_MS);
          if (!(await onPage(message.page, message.text))) finish("dropped");
        }).catch(error => finish(error instanceof Error ? error.message : String(error)));
      });
      worker.once("error", (error: Error) => finish(tf("server.documents.ocrReadFailed", { reason: error.message })));
      worker.once("exit", () => { void chain.then(() => finish(t("server.documents.ocrReaderStopped"))); });
    });
  } finally {
    work.worker = null; work.documentId = null;
    await worker.terminate().catch(() => {});
  }
}
