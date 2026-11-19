# Document knowledge

An ordinary conversation searches the whole library, and the model decides through
`searchKnowledge` what to look up. Only a template with collections narrows that search; knowledge entries are included only when nothing does. Manual tool API
requests may include `chatId` so the server can derive these settings from the
stored conversation. A missing supplied conversation returns 404.

Open **Knowledge** and choose **Import document** (top right) to select a PDF, UTF-8 Markdown (`.md`), UTF-8 text (`.txt`) or Word `.docx` file and, optionally, a topic. **Preview import** first shows a local, read-only extraction preview: inspect headings, rows, amounts, conditions and missing content, then click **Confirm document save**; the import card then closes. **Discard preview** writes nothing. The original file is not retained: SQLite stores the extracted text, filename, PDF page numbers and a local search index. Keep the original separately if you need its formatting or binary contents. The one exception is a PDF with scanned pages, kept in the cache only until those pages are read (see [Scanned PDFs](#scanned-pdfs)).

To import several documents at once, choose more than one file, use **Folder** to take every PDF, Markdown, text and Word file in a folder and its subfolders, or drop files on the import card. Files of a folder that share a name (`finance/readme.md`, `hr/readme.md`) are named by their path in it (`finance › readme.md`, `hr › readme.md`) so neither overwrites the other, and importing the folder again gives the same names; other files keep their own name. They are imported one at a time under the topic given, without the preview step, and each row shows how it went: **Added**, **Updated** (a document with the same filename), **Unchanged**, **Failed** with the reason, or **Skipped** for a file the library cannot read or one over 32 MiB. A document already saved stays saved when a later one fails or the batch is stopped; **Retry unfinished** imports what is left. When the service is busy the batch waits as long as it asks and carries on. Check each document's extracted text in the library afterwards. A single file still goes through the preview.

Confirmation extracts the file again and verifies that the preview text and same-filename document identity, content hash and collection still match. A concurrent import, deletion/recreation or collection move returns conflict instead of overwriting newer data; preview again before saving. Preview data lives only on the open page. There is no server preview cache, durable upload or model call. If a first-save response is lost, refresh and preview again to see the saved document before repeating confirmation.

Importing a file with the same exact filename updates the document. Identical extracted text and collection leave the index unchanged; changed paragraphs add/remove chunks while chunks in unaffected sections keep their IDs. **Reindex** rebuilds local terms, frequencies, section paths and table chunks from saved text. It does not call an embedding model or rerun file extraction. Index version 4 lets short paragraphs of one section share a chunk of up to 800 characters, so a condition and its exceptions stay together; a heading, a table or a fenced code block always starts its own chunk. Version 3 retained table headers with each complete group of rows. Old local indices are marked **Local index needs updating** and, while an embedding model is chosen, are rebuilt automatically before their vectors. Index replacement is transactional, so validation failures and failed writes preserve the working version.

Word extraction preserves standard Heading 1–6 styles, list membership and table rows/columns as plain Markdown. Ordered list items use neutral `1.` markers rather than reproducing the original numbering. An explicitly marked Word header row becomes the table header; otherwise generated labels such as `列 1` (“Column 1”) keep the first row as data. Merged cells repeat their value at each occupied coordinate with a merge marker; this representation needs human review. Markdown pipe tables keep complete rows and repeat their original header and divider in every table chunk. Escaped pipes and inline code delimiters do not split cells. Ordinary long paragraphs retain the existing overlap. Saved text from older Word imports cannot recover previously flattened rows, headings or merged cells: **reimport the original Word file** to obtain the new structure. Reindex alone cannot restore missing source information.

Headings inside fenced code examples remain literal reference text and do not
change the section path of later evidence. Escaped trailing backslashes do not
hide a table's closing delimiter. If documents were indexed before these fixes,
use **Reprocess** to repair their saved headings/table chunks; affected semantic
vectors are invalidated and rebuilt in the background while an embedding model is chosen. Unchanged paragraphs retain
their IDs, and a content-preserving reindex keeps document citation versions.

The document panel supports keyword search without a model key, and hybrid search when compatible semantic vectors exist. Chat adds nothing from the knowledge base on its own: the model calls `searchKnowledge` when it judges a question needs it, and a request that does not search carries no knowledge text. A chat model without tool calling, or a template that does not allow `searchKnowledge`, therefore answers without the knowledge base. Source cards under an answer come from those searches; answers stored by earlier versions keep the sources they recorded.

## Synced folders

**Synced folders** in the documents view keeps the knowledge base in step with folders on this computer (desktop app). **Add folder** opens the folder dialog; choose an optional topic and **Start syncing**. Unlike **Folder** on the import card, which imports a folder's files once, a synced folder stays connected:

- Every PDF, Word, Markdown and text file in it, subfolders included, is a document named `<folder>/<path inside it>` (for example `Handbook/finance/invoices.txt`), under the folder's topic. Two folders with the same name are told apart as `Handbook (2)`.
- While RiA runs, each folder is watched: a saved change is picked up about two seconds later, and a folder that keeps changing (a log written all the time) is still scanned at least every 30 seconds. At start-up every folder is scanned for what changed while RiA was closed, and **Sync now** in a folder's menu scans it at once. A scan compares each file's size and modification time with the last scan and reads only files that changed.
- A changed file is imported again as the next version of its document, through the same path as an upload, scanned pages included. A file that is deleted or moved out of the folder takes its document with it. A moved or renamed file is a new document: citations of the old one report it deleted.
- Left out: hidden files and folders (starting with `.`), Office lock files (`~$…`), `node_modules`, the recycle bin, other file types, and links or junctions, which are not followed. A file over 32 MiB, an empty one, or one whose document name would pass 180 characters is listed as left out; a file that cannot be read is listed with the reason. The row reads **2 files left out**, and **Show the files left out** lists them. Such a file is tried again when it changes, or on **Sync now**; a version that cannot be read keeps the document of the last one that could.
- Nothing is removed unless the scan was complete. A folder that cannot be found (moved, deleted, or on a drive that is not connected) reads **Folder not found** and keeps its documents. RiA looks for it again every minute while it runs, and at start-up and on **Sync now**, so it syncs again within a minute of coming back. Subfolders that cannot be read keep their documents too, and a folder of more than 200,000 entries stops the scan with nothing removed.
- A synced document is not deleted from the library, since the next scan would bring it back: delete or move the file, or stop syncing. **Stop syncing** keeps the folder's documents as ordinary ones; **Remove folder and documents** deletes them from the knowledge base. Neither touches the files.

RiA only reads a synced folder. It is not a directory grant: the assistant gets no access to it, and the same locations are refused as for grants (network shares, drive roots, system and profile roots), as well as RiA's own data and cache folders, and a folder inside or around one already synced, whose files would otherwise become two documents each. Up to 20 folders can be synced. The folder list is a setting of this computer, like grants, and is not part of backups; after a restore, the folders' files are imported again from the folders as they are now.

## Scanned PDFs

A PDF page with almost no text layer (fewer than 20 characters) is treated as scanned: a scan, or text drawn as outlines. Pages are not checked for images first, because that decodes every image during the import and took about twenty times as long as reading the text. Its text is read by OCR after the import, on this computer: Tesseract (tesseract.js 7, WebAssembly) with its compact English and Simplified Chinese models, which ship with the app. Nothing is downloaded and no model provider is called.

- **Import.** The preview says how many pages are scanned. The document saves at once with the text it already has, so its text pages are searchable straight away, and a PDF that is scanned throughout imports with no text yet. A Markdown, text or Word file with no text is still refused.
- **Reading.** Pages are read one at a time in a background worker, about 200 dpi (at most 12 megapixels a page), taking a few seconds per page and at most three minutes for any one page. The row reads **Reading text 3/10 pages** meanwhile. Each page's text is saved as it is read, so a restart carries on from the next page: the desktop app resumes a few seconds after starting, and opening the library resumes it too. When every page is read, the text joins the document as one new version and is indexed like any other change. A page where nothing is recognized, such as a blank page, keeps the little text it had.
- **The kept PDF.** The scanned PDF waits in the cache folder (`ocr/<document id>.pdf`) until its pages are read, then goes. Deleting the document, or importing it again with all its text, stops the reading and removes the file. Files left without a job, after a restore or a crash, are removed the next time reading resumes. Moving the cache carries the waiting PDFs with it.
- **Failure.** A page that cannot be read, or a kept PDF that is missing or changed, marks the row **Text recognition failed**, keeping the pages already read. The reason shows when you point at the label. **Read text again** in its menu continues from the first unread page; if the kept PDF is gone, import the same file again, which brings it back and carries on. A PDF where no page yields any text fails with **No text was found on the scanned pages**.
- **Importing the same file again** reuses the text already read from that exact file (matched by its SHA-256), so nothing is read twice and an unchanged document stays unchanged.

Recognition quality follows the scan: clean printed pages read well, while handwriting, low resolution, skew and complex layouts read poorly. Spaces Tesseract puts between Chinese characters are removed; spacing between Latin words is kept. Check important passages against the page. Only English and Simplified Chinese are recognized.

Backups hold a document's text as last saved, which gains the scanned pages only once they are all read. Raw SQLite backups also hold the reading jobs, but not the kept PDFs in the cache, so after restoring one a job still waiting reports **Text recognition failed**; portable workspace archives hold no jobs. Either way, import the PDF again to read pages that were still waiting.

## Configure and build semantic retrieval

1. Select an embedding model from the existing model settings and configure its provider. Choosing it is the consent to send the knowledge base's content to it: the setting says so.
2. Import documents. Anything without a current vector for that model is then built in the background, one batch of 32 chunks at a time: new imports, documents from before the model was chosen, and everything after the model changes. Knowledge entries follow the documents in the same run. Document rows show **Processing**, **Waiting** or **Ready**; **Search settings and diagnostics** has the counts.
3. Ask a paraphrased question in the library or chat. In chat the model writes its own search query.

Saved vectors are the record of progress, so an interrupted run loses nothing and the next carries on, including after a service restart: opening the library resumes it. A failure stops the run instead of trying every document against a provider that is refusing, and it is not retried until something asks again (an import, a model change, or **Build or resume in bulk**). An unchanged completed index makes no new provider call. **Build or resume in bulk** remains for building what is pending by hand: each explicit request processes at most 32 pending chunks with a 30-second provider deadline, and one page operation makes at most 48 sequential requests, under the 60-per-minute quota.

**Search settings and diagnostics** derives completed, stale, malformed and different-model vector counts from the search index, which checks the actual vector and its contextual hash when it loads a document, rather than counting non-null fields. It also identifies old local indices. The per-document progress list describes this page's latest manual operation. Saved vectors are the source for continuation. These status checks do not prove semantic quality or compatibility with a provider whose output dimensions change without a model-ID change; retrieval diagnoses incompatible dimensions separately.

Vectors are stored in local SQLite as unit-length little-endian Float32 (`document_chunks.vector`), qualified by provider, model and the hash of the contextual text used for embedding. A changed paragraph, section, filename or collection invalidates affected vectors: database triggers clear them as the change is written, whichever code path writes it. A model change excludes vectors from the old model, and the new index is built in the background. Missing credentials or a query embedding failure leave keyword retrieval available. Query cancellation still cancels the operation. Vectors must contain finite numeric values, have a nonzero norm and at most 8,192 dimensions; different dimensions are never compared.

Keyword ranking uses BM25 (k1 1.2, b 0.75) with term frequencies, corpus rarity and chunk length, from SQLite's full-text index (FTS5), scored in full over every passage sharing a term before the 200 keyword candidates are chosen. Each chunk is one row of its terms, the same terms extracted before (locale-aware word segmentation, stop words removed), each written as its UTF-8 bytes in hexadecimal and repeated by its frequency, so the index's tokenizer never splits a term such as `SQLITE_MAX_ATTACHED` and BM25 sees the same frequencies and lengths. Corpus rarity is counted over the whole library, also when a template narrows the search to some collections. On the evaluation set the move to the full-text index ranked every question exactly as before, with and without meaning. Semantic ranking covers every compatible chunk in the selected collections and keeps the 64 closest; the query is embedded as typed, as passages are, without lowercasing. The vectors of the chosen model are held in memory as int8 with a scale per vector (a quarter of their Float32 size); a search scans all of them, takes the closest 256, and scores those exactly from the stored Float32 vectors, so the ranking returned is the exact one. The index reloads only documents whose vector revision changed since the last search, and is rebuilt from the database after a restart: the desktop app loads it in the background a few seconds after starting (about five seconds for 100,000 vectors), so the first search does not wait for it. The two are combined by score: each list is scaled to 0–1 within the search, and meaning weighs 0.75 against keywords 0.25. On seven public laws and technical documents with bge-m3, this put the answer in the top five for 21 of 24 questions, against 19 when the ranks were added instead (reciprocal rank fusion), which let passages sharing a few of the question's words outrank the one that answered a reworded question. A passage whose vector is not built yet competes on keywords alone, so it ranks lower until the automatic job reaches it. Highly overlapping passages within one document are reduced, while evidence from separate documents remains available to expose conflicts. There is no two-chunks-per-document cap. Adjacent excerpts have their own source IDs and URLs. Markdown heading paths supply context without a second model call.

A search makes one query embedding, shared by documents and knowledge entries. Documents keep their fused order; a knowledge entry that matches keeps a place of its own (one in four results) so passages cannot crowd it out. An entry matches when it contains enough of the query's words, or when it is at least as similar in meaning as the least similar document that made the list: the same model's scale, whatever its absolute numbers. Without a requested count, a search returns six results; a quarter of the places go to the paragraphs around the best hits, so six keeps five ranked passages. The result tells the model when it rests on keywords alone (no model chosen, nothing built yet, or the query embedding failed) or covers only part of the documents, so an empty result is not mistaken for missing knowledge. A document result carries its text once, in its reference.

This is exact local vector retrieval under the existing 100-document/256-chunk limits, without a separate vector server or approximate-nearest-neighbor extension. There is no fixed similarity threshold: each embedding model has its own scale, and on the one measured (bge-m3) the passages that answered a question scored 0.54–0.75 while the best passage for a question the library could not answer scored 0.48–0.60, so no cutoff separates them. The closest passages are ranked and fused with keyword matches, and the model judges what they say. Keyword matching likewise has no minimum: requiring two shared words dropped the right passage for two of thirty questions and barely shortened results for questions without an answer. Scores cannot prove that a passage answers a question. A search scans every stored vector; reading them, as JSON through the database client, costs about 0.25 ms per chunk (about 0.7 s at 2,000 chunks and 1.8 s at 6,000), so larger limits need a more compact vector storage first. There is no generative query rewriting or paid reranking step.

## Privacy and retention

Parsing, keyword indexing and keyword-only searches run locally. While an embedding model is chosen, indexing sends document snippets and their context to that provider and may incur costs. Searching with compatible indexed documents sends the search query to that provider; this may also incur costs. Retrieved excerpts are sent to the configured chat model with the conversation. Vectors stay local, but provider handling of submitted text depends on that provider's policies. Imported text is marked as untrusted reference data in the prompt; this is not a guarantee against every model prompt-injection attack.

Deleting a document removes its saved text and search index. Existing chat citation snapshots, answers and tool memories can still contain excerpts or facts from the document; delete those separately when needed. A link to a deleted document reports that it is unavailable. If an individual chunk changed, its old link explains that the current document differs while the chat retains the earlier excerpt. Backups can also retain deleted content; this is logical deletion, not secure disk erasure.

Document data lives in the existing SQLite database, not `public/` or a new filesystem directory. Raw SQLite backups include vectors. Portable workspace archives preserve extracted text, headings and lexical indexes, but omit regenerable document vectors to keep archives bounded; rebuild semantic indexes after restoration. Older archives remain readable with default frequencies and absent headings. A complete application backup must still include the private media directory for images/videos. Desktop startup backs up an existing database before applying migrations; back up manually before applying migrations through the Web CLI. The migration preserves existing chunks, source identities and terms; it neither sends data to a provider nor builds vectors.

## Bounds and supported content

| Boundary | Limit |
| --- | --- |
| Upload | One file, 32 MiB; 33 MiB multipart request, counted from the actual stream. What it holds once extracted is bounded separately below, since every chunk is a vector each search reads |
| Stored text | 4,000,000 UTF-16 code units per document |
| PDF pages | 1,000 |
| Chunks | 10,000 per document and 100,000 in the library; at most 1,000 code units with 100-character overlap within long paragraphs; tables repeat headers with complete rows |
| Table row | Header + divider + any single row must fit within 1,000 code units; split wider tables or long cells before importing |
| Documents | 2,000 |
| Import and reindex | Shared local instance quota of 60 attempts/minute |
| Import preview | Separate local instance quota of 30 attempts/minute; no database write or model call |
| Semantic indexing | 12 batch requests/minute; at most 32 chunks/request |
| Parsing | At most two workers per service; 90-second deadline; 256 MiB old-generation JS heap per worker |
| Scanned pages | One OCR worker per service, one page at a time; 3 minutes per page; about 200 dpi, at most 12 megapixels a page; English and Simplified Chinese |
| Word archive | 500 non-directory entries; at most 64 MiB of actual decompressed data |

Workers receive no inherited environment variables, use buffer input and have `fetch` disabled. PDF JavaScript evaluation is disabled, and the parser does not render images; only the OCR worker renders a scanned page, to a bitmap it reads and discards; Word import serializes its parsed structure as text, discards the HTML conversion tree and does not enable external-file access or embedded style maps. Word structures are bounded to 64 nesting levels, 100,000 visited nodes and tables of at most 2,000 rows and 64 columns. The heap limit does not cap all native allocations; these controls bound common local resource abuse and are not an OS sandbox for hostile public uploads. Existing media and Proxy body limits are unchanged.

Scanned pages are read by the built-in OCR (see [Scanned PDFs](#scanned-pdfs)); images inside Word files are not. Encrypted PDFs, legacy `.doc`, macro-enabled Word, arbitrary binary text and malformed files are rejected. No original-file download, original visual table-layout preservation or automatic background parsing is provided. PDF retains page numbers and extracted text order; complex PDF tables and columns require manual review rather than assuming Word-style structure. Complex layouts/fonts may extract imperfectly; inspect the source page before relying on them. Keyword ranking uses up to 24 normalized query terms and 200 lexical candidates; semantic candidates cover the full selected corpus independently of those matches and document recency.

## API and validation

| Endpoint | Contract |
| --- | --- |
| `GET /api/documents` | Bounded summaries with `semantic: { modelRef, indexed, total, lexicalCurrent, stale, differentModel, invalid }` for the selected model; no query parameters |
| `POST /api/documents/preview` | Multipart `file`, optional `collection`; local read-only extraction with filename, format, byte size, character count, index version, chunks, notes, `previewHash` and nullable `base` |
| `POST /api/documents` | Multipart `file`, optional `collection`; UI confirmation additionally sends `previewHash` and JSON-string `base` together; returns `data.document`, `change`, `added`, `retained`, `removed`; HTTP 201 for creation, 200 for updates/unchanged content |
| `GET /api/documents/:id` | Document summary and extracted chunks; no raw original file |
| `POST /api/documents/:id` | Reindex saved text; empty body or `{}` |
| `DELETE /api/documents/:id` | Delete saved document and index; empty body or `{}` |
| `POST /api/documents/:id/embeddings` | JSON `{ "confirm": true, "contentHash": "<64 hex>", "modelRef": { "providerId": "openrouter", "modelId": "<selected embedding ID>" } }`; returns `indexed`, `total`, `remaining`, `modelRef`; matching document version and selected model required |
| `POST /api/documents/search` | JSON `{ "query": "question", "collections": [] }`, 1–2,000 characters; up to eight source snippets; shares the tool request quota |

All endpoints use the existing [authentication, Origin and error contracts](api-security.md). Foreign and missing document IDs return the same 404. Parser capacity returns 503 with `Retry-After`; parsing deadline returns 504. Import quota exhaustion returns 429. Oversized files, extracted text, archives or chunk counts return 413.

Multipart requests reject unknown/duplicate fields, require one file and reject collections longer than 40 characters after trimming. `base` is `null` for an absent filename or `{ id, contentHash, collection }` for the existing document. `previewHash` is the hash of extracted pages, not a credential. It must match the confirmation extraction; `base` is checked inside the write transaction. Mismatches return 409. Legacy authenticated integrations may still import directly without both confirmation fields; the preview workflow is enforced by the UI, not a new API authorization requirement. A header plus row too wide for one chunk returns 400 with a request to split it, preserving any saved version.

`tests/fixtures/document-retrieval.json` is the minimal fixed evaluation corpus: six source documents and eight Chinese/English questions, supplemented with forty newer distractors in the test. `npm run test:server` reports Recall@3 and MRR@3 and requires both to remain 1.0 for this small corpus. This is a regression baseline, not a claim about arbitrary document accuracy.

PDF.js, Mammoth, JSZip, tesseract.js and its English and Simplified Chinese data packages are application dependencies, pinned in the lockfile. The workers use native Node resolution because bundler module IDs are not filesystem paths. Next's output tracing explicitly includes these packages and their installed runtime dependencies, including PDF character maps/fonts, the platform canvas binding that renders scanned pages, the Tesseract cores and the `4.0.0_best_int` models; `npm run desktop:verify` fails when one is missing. In Node, tesseract.js 7.0.0 always loads its full cores (`tesseract-core-relaxedsimd`, `-simd` or plain), never the LSTM-only builds, so those are the ones shipped. Keep that tracing synchronized when upgrading parsers or OCR, and run `npm run test:desktop:package`: only the packaged app reads OCR from the runtime's own files, while the unpackaged smoke run can fall back to the repository's `node_modules`. Browser integration tests import actual generated PDF/DOCX files through the production standalone service; Electron smoke tests repeat binary imports and verify text/index retention after service restart. No paid provider is used by these checks.

## Upgrading from knowledge topics

Earlier versions had **Knowledge topics**: workspaces over chosen collections that generated reports, plans and summaries. They have been removed.

- A conversation started from a topic stays as an ordinary conversation with all its messages. Like every conversation, it searches the whole library unless a template narrows it.
- Each finished result became a conversation named `topic · title`, with its instructions as your message and the result as the answer. Source links in a result still open the cited passage. Results that had failed, were cancelled or never finished had no text and were not kept.

The upgrade (`20261116100000_remove_knowledge_topics`) does this once; the desktop backs up the database first. A backup made before the upgrade restores the same way. Older builds cannot read the changed tables; rolling back means restoring the backup taken before the upgrade.

## Knowledge entries

Knowledge entries are the part of the knowledge base a person or the assistant writes as
short named items rather than imports. They are not long-term memory, which is
[a separate document the model keeps](long-term-memory.md), and a conversation's memory
switch does not touch them. They are still stored in the `memories` table and reached at
`/api/memory`, names kept so existing data, backups and integrations keep working.

Collection names containing `|` are supported. Such scopes are stored as a
versioned JSON string; ordinary scopes retain the previous representation. The
toolbar, chat retrieval, tool retrieval and backups share the same decoder.
Existing scopes remain readable. An old scope that used `|` inside a name was
already ambiguous; clear it and select the intended collection again. No
document is renamed or deleted. Backups containing the new representation
require this version or a newer version to restore the scope correctly.

Every entry records where it came from: added by hand, or inferred by the assistant. An inferred entry is stored as a **candidate**: visible, editable and deletable in the knowledge page, but it does not enter the context of any answer until you accept it. New candidates are no longer made; older ones may arrive from a backup.

With `saveKnowledgeEntry`, the model can add a named entry or replace an entry by its exact name. Under **Full access** the save can proceed directly. Under other approval rules the card shows the proposed text and, on replacement, the existing text. If the entry changes while approval is pending, the save is refused and the model is told to look it up again. A new name adds a new entry. You can also save entries directly in the knowledge page. Old conversations, templates and backups may refer to the tool by its earlier id, `saveMemory`. [Approval rules](terminal-tools.md#approval-rules)

The model retrieves matching confirmed entries through `searchKnowledge`. The requested result count covers both entries and document passages, defaults to six and can be set up to eight. Matching entries can reserve space based on keyword coverage or similarity compared with the selected document passages. Entries are outside document collections, so a search scoped to chosen collections leaves them out.

Editing and saving a candidate accepts it. A restored or older entry may also carry a last-used timestamp.

Provenance travels with workspace backups. Restoring an archive does not turn an inference you never accepted into one you are treated as having accepted.

## Retrieval evidence and citation versions

Every search uses one source count and excerpt character budget;
templates do not change them. Chat, the library and `searchKnowledge` share these limits. Near-identical
clauses remain separate when their actual wording differs, so quantities and
exceptions in one document are not discarded as duplicates. Only identical excerpts
within a document are deduplicated. Evidence budgets retain complete source snippets.
See [Assistant templates](assistant-templates.md) for defaults and scope overrides.

Preview search takes `query` and optional `collections` and uses the default policy; it
retains the existing `data` array. Its additional `diagnostics` explains empty
scope (without claiming an untested model is missing), no hits, missing model, absent compatible indices or embedding failure with
keyword fallback. Counts include scoped chunks, compatible/scanned/stale vectors,
candidate counts, invalid or mismatched vector dimensions, selected excerpts, excerpt characters, duration and policy.
In chat, `searchKnowledge` returns diagnostics with the tool output, including
searches with no sources. Older messages can also contain saved diagnostics from
before search moved to the tool. Diagnostics describe retrieval coverage and do
not contain query or document text. Answer correctness requires separate review.

### Explicit quality evaluation

Open **Retrieval quality evaluation** in the document library, replace the example questions with
representative cases from your own documents, and optionally choose an assistant
template. Run retrieval alone, enable **Also generate answers**, or additionally enable
**Model semantic review**. The latter sends the generated answer, retrieved excerpts and
scoring criteria to a chat model for another potentially billed call per question.
The UI confirms the data flow and fees. It defaults to reviewing with the answer
model, so this is not an independent reviewer. The API can explicitly select a
different allowed chat model. Model fallback can cause additional provider attempts.
No tools or long-term memories are used. Template-loading failures are visible and
can be retried; default-model evaluation remains available.

`POST /api/documents/evaluate` requires `confirm: true`, optional `generateAnswers`
(default false), optional `judgeAnswers` (default false, requires answer generation),
optional `judgeModel: {providerId, modelId}` (requires judging; existing chat-model
allowlist/credentials apply), optional `assistantTemplateId` (its model, instructions and collections; retrieval uses the default policy),
and 1–12 `cases`. Each case contains `question`, optional `collections`,
`expectedFilenames`, `requiredFacts`, optional `expectations` (up to 12 objects with
`kind: fact|condition|exception|quantity|conflict` and a complete `statement` of at
most 400 characters), and `answerable` (default true). An unanswerable
case must leave expected documents, facts and expectations empty. Explicit case collections
override template collections for that evaluation; normal chat uses the limit from its topic or template.

The returned report includes each case's actual excerpts, diagnostics, filename
recall, exact-text fact coverage in evidence/answer, matching citation count,
unknown knowledge links, generated text, response model ID and timing. Missing
expectations produce null metrics. Expected facts, filenames and typed expectations
never reach the answer-generation prompt. Facts and expectations are supplied only
to the separate judge. Per-case failures retain retrieved
evidence and report a failure instead of fabricating an answer. Calls are sequential,
use the foreground retry rule for transient provider failures, and obey existing model admission, fallback and usage recording.
Attempts appear under embedding and tool usage; costs are unknown unless the provider
or configured rates report them, not assumed free. The report's model names the
requested model; `responseModelId` and usage records identify actual responses.

The endpoint allows two runs/minute, caps the request at thirty minutes and each
answer/judge call at five minutes, and propagates cancellation. Answer and judge
output follow the general model output rule: the known output limit, or the
provider's own default when none is known, so reasoning models are not cut short.
Long batches with reasoning models can still exceed the overall deadline; use
smaller batches rather than expecting every maximum-sized run to finish. Already-sent calls may
still be charged. A cancelled run yields no completed report. Reports are kept in
page state and may be explicitly downloaded as JSON; exports contain questions,
source excerpts and answers. They are not automatically written to the workspace.

Fact coverage remains explicitly labeled literal matching. Citation matching checks
that a link points at retrieved evidence, not whether the adjacent claim follows
from it. Optional review checks grounding, claim-to-citation support, answer/refusal,
each required fact and each typed expectation. Verdicts are pass/fail/uncertain/
not-applicable, with reasons and exact answer/evidence quotes. Only grounding and
citations can be not-applicable when no document facts are asserted. Negated facts,
omitted prerequisites/exceptions, altered quantities/units and hidden conflicts
must not pass merely because matching words or valid links occur. Related retrieval
for an unanswerable question is a diagnostic, not an automatic refusal failure.

The server validates every check ID exactly once, quote membership in the actual
answer/source, and evidence for passed facts/expectations. Malformed, incomplete or
invented quotes yield a failed review with no scored checks; the generated answer
and retrieval metrics remain available. Provider failures behave the same way.
Reports record the requested judge model and actual response model ID. Model verdicts
and reasons are fallible, even with verified quotes: these checks do not prove
entailment, and the judge can also be affected by untrusted document content.
Human review is still required. Automated suites use synthetic vectors and offline
HTTP models; passing them is not a live-model accuracy claim.

`tests/fixtures/document-quality-evaluation.json` contains eight sample documents,
40 answerable questions with structured expectations, ten unanswerable questions
(including related evidence and missing scope), and six correct/incorrect answer
pairs covering negation, conditions, exceptions, units, conflict and fabrication.
For an explicit live evaluation, import those sample documents or replace them with
representative private documents; submit `cases` in batches of at most 12. Answer
examples are for human calibration, never additions to the generation prompt.
The offline regression validates all 50 case contracts and local retrieval of the
40 named-document cases; it does not measure real semantic judgment quality.

Document search and `searchKnowledge` use the same hybrid retrieval. Preview
search does not call a chat model. The library's collection selector uses
exact names, including names containing `|`. `POST /api/documents/search` accepts
optional `collections` (up to 12 names of 40 characters); omitted or empty means
all collections. Chat and tool retrieval use the limit from the conversation's topic or template. Results distinguish `local-keyword`, `semantic`, `hybrid` and `neighbor`,
and include section paths, matched terms, collection and document content hash.
These explain how a fragment was selected, not a probability
that it answers the question. A keyword overlap can be useful yet contain no answer.

The model prompt requires applying and combining evidence, preserving quantities,
units, prerequisites and exceptions, citing supported claims, disclosing conflicting
documents and stating when a requested document fact lacks evidence. Empty retrieval
adds no knowledge-answer block; the shared agent instructions still prohibit inventing
workspace facts or citations. Retrieved excerpts apply only to relevant tasks, so
unrelated conversation does not require a retrieval disclaimer. This directs the model; it does
not guarantee compliance. Answer sources show whether the generated Markdown actually
links to each versioned snippet. **This excerpt was cited in the answer** means a link was present, not
that its associated claim was verified. **Retrieved reference: not cited in the answer** identifies retrieved
references that the answer did not cite. Both states persist across restart.

New persisted citation snapshots include `contentHash` and collection alongside
the existing excerpt and source identities. Source links carry `?version=<hash>`.
A changed document is reported as changed even if that particular chunk survived
unchanged; a content-preserving reindex leaves the version current. Moving the
collection changes the captured provenance. No full historical document is retained.

The source panel checks versions on mount and when its window regains focus,
with cancellation and stale-response protection. It reports current, changed,
deleted, or old/unverified references. A failed check is explicitly unavailable,
never a green assertion. The excerpt remains the answer-time snapshot. A deleted
document, including a new import with the same filename and a new ID, cannot make
an old reference current again. The viewer shows current extracted text and warns
if the requested version or chunk no longer matches.

`POST /api/documents/references` accepts `{ "sources": [...] }` with 1–8 existing
citation objects in a 24 KiB body. It returns `data` entries containing `chunkId`
and `status` (`current`, `changed`, `deleted`, `unverified`). It performs no model
call, retains normal credential/Host/Origin/workspace-gate checks, uses private
no-store responses, and allows 120 bounded read checks per minute. A current
check describes the time it was read, not continuous filesystem monitoring.

Backup restoration remaps structured source identities and local Markdown
citation links while preserving hashes and excerpts. Optional snapshot fields keep
old conversations and archives readable; references without version evidence are
honestly unverified. No new document table or background watcher is needed.

The lexical corpus has eight positive Chinese/English questions, four unrelated
or stop-word queries and four collection checks, plus forty newer distractors.
Recall@3, MRR@3 and empty-result checks are regression evidence for this corpus,
not a broad semantic-answer-quality benchmark or a claim that lexical matches
always contain answers. See [Testing](testing.md) for the real HTTP/browser checks.

`tests/fixtures/document-rag-evaluation.json` adds four indirect questions with
required facts/conditions across finance, operations, HR and identity recovery.
Controlled synthetic vectors demonstrate lexical Recall@8 of 0.25, hybrid Recall@8
of 1.0, complete required-evidence coverage and four empty unrelated queries.
This tests retrieval mechanics, not live embedding or answer quality. For a live
evaluation, use your selected embedding/chat models on representative documents,
check paraphrases, multi-paragraph conditions, contradictions, collection isolation,
unsupported details and follow-ups, and verify every cited claim against its excerpt.
Record model IDs, question set, recall, evidence coverage, unsupported claims,
latency and costs. These calls are explicit and can incur charges.


## Library layout

The knowledge page opens on an overview: one search field, the five most recently updated documents and the five most recent knowledge entries. Each section's **All** link opens the full view of that kind (`/knowledge?view=documents` or `/knowledge?view=entries`), with a path back to the overview above its title; the browser's back and forward move between them. Entries waiting for confirmation are counted next to the entries heading (**N to review**), which opens the entries view filtered to them.

The overview's search filters knowledge entries as you type, after a short pause. Searching inside document content can embed the query with the chosen model, so it is a separate row under the matching entries and runs only on **Enter** or a click; its excerpts appear below it. **Esc** clears the search.

The documents view holds the whole library: topic filter, content search (on **Enter**), and the document list. Document rows show filename, collection, excerpt/character counts, a plain status (**Reading text 3/10 pages** or **Text recognition failed** for a scanned PDF, then **Processing 32/40**, **Waiting 32/40**, **Ready** or **Needs update**) and index time; their menu offers **Reprocess**, **Read text again** after a failed reading, and deletion. How search works underneath lives in one place, **Search settings and diagnostics**, collapsed at the end of the documents view: index progress and vector counts, running, continuing or cancelling a build by hand, what the latest library search did (candidates, vectors scanned, threshold), and **Retrieval quality evaluation**. Citations, topics, model settings and templates do not show these terms; a chat's execution record keeps its own diagnostics.

The entries view is a full-width list with search as you type, the confirmation filter and pagination; the search it currently shows is named under the field, so a failed newer search does not hide which results are on screen. **Add entry** opens a keyboard-accessible dialog; failed saves retain the draft, closing it with something written asks before discarding that, and long entries support an abbreviated preview with **Expand full text**. Existing entry edits, confirmation and deletion remain available inline.


Recognized `tool-memory-v1` records display a readable subject, tool label and summary instead of their storage envelope. **View content** expands a sanitized Markdown answer excerpt; **Original record** exposes the complete stored key/value. Previewing these excerpts does not load embedded images. This is presentation only: editing still uses the original value, and search, confirmation, IDs and persisted keys remain unchanged. Manual notes and unsupported or malformed envelopes retain their plain text; long or multiline notes use a two-line preview with full expansion.
