# Document knowledge

Automatic `searchKnowledge` tool calls and manual searches from a conversation
honor that conversation's selected collections. An empty selection searches all
collections. In a conversation with memory disabled, these tools do not read or
write long-term memories; imported documents remain available. Manual tool API
requests may include `chatId` so the server can derive these settings from the
stored conversation. A missing supplied conversation returns 404.

Open **知识库管理 → 文档知识库** to import a PDF, UTF-8 Markdown (`.md`), UTF-8 text (`.txt`) or Word `.docx` file. The original file is not retained: SQLite stores the extracted text, filename, PDF page numbers and a local search index. Keep the original separately if you need its formatting or binary contents.

Importing a file with the same exact filename updates the document. Identical extracted text and collection leave the index unchanged; changed paragraphs add/remove chunks while unaffected chunks keep their IDs. **重新索引** rebuilds local terms, frequencies and Markdown section paths from saved text. It does not call an embedding model or rerun file extraction. Reindex existing documents once after this upgrade to populate section paths and term frequencies. Index replacement is transactional, so validation failures and failed writes preserve the working version.

The document panel supports keyword search without a model key, and hybrid search when compatible semantic vectors exist. Chat automatically supplies up to eight versioned snippets to the configured chat model. Retrieval expands adjacent paragraphs to retain conditions and exceptions. The knowledge-search tool prioritizes document evidence before filling remaining slots with confirmed memories and built-in notes. Filenames, excerpts and source links appear below the answer. PDF sources identify their page; other formats identify their chunk. The source page requires the same authentication as the knowledge library and renders extracted text rather than document HTML.

## Configure and build semantic retrieval

1. Select an embedding model from the existing model settings and configure its provider.
2. Import documents and inspect their extracted text. For older documents, use **重新索引** first.
3. Click **语义索引** for each document and confirm sending its filename, collection, section paths and text snippets to that model. The panel shows indexed/total chunks for the selected model.
4. Ask a paraphrased question in the library or chat. Select the appropriate collections to narrow evidence. A short follow-up can reuse the preceding user question; assistant speculation is excluded from this query context.

Import never starts billable indexing automatically. Each explicit indexing request processes at most 32 pending chunks, with a 30-second provider deadline. The page makes at most eight sequential requests for a document. Completed batches persist if a later batch fails; click the button again to continue. An unchanged completed index makes no new provider call. Embedding calls have no automatic retries. Duplicate requests for one document return conflict; document/model changes or cancellation prevent an obsolete batch from committing. Leaving the library cancels its in-flight request.

Vectors are stored in local SQLite, qualified by provider, model and the hash of the contextual text used for embedding. A changed paragraph, section, filename or collection invalidates affected vectors. A model change excludes vectors from the old model; explicitly build the new index. Missing credentials or a query embedding failure leave keyword retrieval available. Query cancellation still cancels the operation. Vectors must contain finite numeric values, have a nonzero norm and at most 4,096 dimensions; different dimensions are never compared.

Keyword ranking uses BM25 with term frequencies, corpus rarity and chunk length. Semantic ranking scans every compatible chunk in the selected collections, in 64-row pages, retaining bounded candidates. Reciprocal rank fusion combines these rankings. Highly overlapping passages within one document are reduced, while evidence from separate documents remains available to expose conflicts. There is no two-chunks-per-document cap. Adjacent excerpts have their own source IDs and URLs. Markdown heading paths supply context without a second model call.

This is exact local vector retrieval under the existing 100-document/256-chunk limits, without a separate vector server or approximate-nearest-neighbor extension. The cosine cutoff (0.35) is a relevance heuristic, not calibrated confidence. Scores cannot prove that a passage answers a question. Larger corpora and model-specific thresholds need measurement before increasing these limits. There is no generative query rewriting or paid reranking step.

## Privacy and retention

Parsing, keyword indexing and keyword-only searches run locally. Explicit semantic indexing sends document snippets and their context to the selected embedding provider and may incur costs. Searching or chatting with compatible indexed documents sends the retrieval query to that provider, including the preceding user question for a contextual follow-up; this may also incur costs. Retrieved excerpts are sent to the configured chat model with the conversation. Vectors stay local, but provider handling of submitted text depends on that provider's policies. Imported text is marked as untrusted reference data in the prompt; this is not a guarantee against every model prompt-injection attack.

Deleting a document removes its saved text and search index. Existing chat citation snapshots, answers and tool memories can still contain excerpts or facts from the document; delete those separately when needed. A link to a deleted document reports that it is unavailable. If an individual chunk changed, its old link explains that the current document differs while the chat retains the earlier excerpt. Backups can also retain deleted content; this is logical deletion, not secure disk erasure.

Document data lives in the existing SQLite database, not `public/` or a new filesystem directory. Raw SQLite backups include vectors. Portable workspace archives preserve extracted text, headings and lexical indexes, but omit regenerable document vectors to keep archives bounded; rebuild semantic indexes after restoration. Older archives remain readable with default frequencies and absent headings. A complete application backup must still include the private media directory for images/videos. Desktop startup backs up an existing database before applying migrations; back up manually before applying migrations through the Web CLI. The migration preserves existing chunks, source identities and terms; it neither sends data to a provider nor builds vectors.

## Bounds and supported content

| Boundary | Limit |
| --- | --- |
| Upload | One file, 8 MiB; 9 MiB multipart request, counted from the actual stream |
| Stored text | 100,000 UTF-16 code units per document |
| PDF pages | 200 |
| Chunks | 256 per document; at most 1,000 code units with 100-character overlap within long paragraphs |
| Documents | 100 per user |
| Import and reindex | Shared local instance quota of 6 attempts/minute |
| Semantic indexing | 12 batch requests/minute; at most 32 chunks/request |
| Parsing | At most two workers per service; 15-second deadline; 128 MiB old-generation JS heap per worker |
| Word archive | 500 non-directory entries; at most 12 MiB of actual decompressed data |

Workers receive no inherited environment variables, use buffer input and have `fetch` disabled. PDF JavaScript evaluation and image rendering are disabled; Word import extracts raw text and does not enable external-file access. The heap limit does not cap all native allocations; these controls bound common local resource abuse and are not an OS sandbox for hostile public uploads. Existing media and Proxy body limits are unchanged.

Scanned/image-only PDFs need OCR before import. Encrypted PDFs, legacy `.doc`, macro-enabled Word, arbitrary binary text and malformed files are rejected. No OCR, original-file download, table-layout preservation or automatic background parsing is provided. Complex layouts/fonts may extract imperfectly; inspect the source page before relying on them. Keyword ranking uses up to 24 normalized query terms and 200 lexical candidates; semantic candidates cover the full selected corpus independently of those matches and document recency.

## API and validation

| Endpoint | Contract |
| --- | --- |
| `GET /api/documents` | Bounded summaries with `semantic: { modelRef, indexed, total }` for the selected model; no query parameters |
| `POST /api/documents` | Multipart `file`; returns `data.document`, `change`, `added`, `retained`, `removed`; HTTP 201 for creation, 200 for updates/unchanged content |
| `GET /api/documents/:id` | Document summary and extracted chunks; no raw original file |
| `POST /api/documents/:id` | Reindex saved text; empty body or `{}` |
| `DELETE /api/documents/:id` | Delete saved document and index; empty body or `{}` |
| `POST /api/documents/:id/embeddings` | JSON `{ "confirm": true, "contentHash": "<64 hex>", "modelRef": { "providerId": "openrouter", "modelId": "<selected embedding ID>" } }`; returns `indexed`, `total`, `remaining`, `modelRef`; matching document version and selected model required |
| `POST /api/documents/search` | JSON `{ "query": "question", "collections": [] }`, 1–2,000 characters; up to eight source snippets; shares the tool request quota |

All endpoints use the existing [authentication, Origin and error contracts](api-security.md). Foreign and missing document IDs return the same 404. Parser capacity returns 503 with `Retry-After`; parsing deadline returns 504. Import quota exhaustion returns 429. Oversized files, extracted text, archives or chunk counts return 413.

`tests/fixtures/document-retrieval.json` is the minimal fixed evaluation corpus: six source documents and eight Chinese/English questions, supplemented with forty newer distractors in the test. `npm run test:server` reports Recall@3 and MRR@3 and requires both to remain 1.0 for this small corpus. This is a regression baseline, not a claim about arbitrary document accuracy.

PDF.js, Mammoth and JSZip are application dependencies, pinned in the lockfile. The worker uses native Node resolution because bundler module IDs are not filesystem paths. Next's output tracing explicitly includes these packages and their installed runtime dependencies, including PDF character maps/fonts and the optional platform canvas binding when present. Keep that tracing synchronized when upgrading parsers. Browser integration tests import actual generated PDF/DOCX files through the production standalone service; Electron smoke tests repeat binary imports and verify text/index retention after service restart. No paid provider is used by these checks.

## Memory provenance and candidates

The conversation's memory switch also controls the explicit `saveMemory` tool:
it is omitted from automatic tools when memory is disabled, and manual calls
return a validation error without writing. Other conversations can still save
memory normally.

Collection names containing `|` are supported. Such scopes are stored as a
versioned JSON string; ordinary scopes retain the previous representation. The
toolbar, chat retrieval, tool retrieval and backups share the same decoder.
Existing scopes remain readable. An old scope that used `|` inside a name was
already ambiguous; clear it and select the intended collection again. No
document is renamed or deleted. Backups containing the new representation
require this version or a newer version to restore the scope correctly.

Every memory records where it came from: added by hand, or inferred by the assistant. An inferred entry is stored as a **candidate**: visible, editable and deletable in the knowledge page, but it does not enter the context of any answer until you accept it. An inference therefore does not become a fact on the next turn, and it never takes effect where you cannot see it.

Editing a candidate is how it is accepted. A memory written by hand is stamped with the time it was last used, and the page shows **last used** so it is clear which memories are doing something and which have gone untouched.

Provenance travels with workspace backups. Restoring an archive does not turn an inference you never accepted into one you are treated as having accepted.

## Retrieval evidence and citation versions

Templates can tune the semantic threshold, source count and excerpt character
budget. Chat context, preview and `searchKnowledge` share these limits. Near-identical
clauses remain separate when their actual wording differs, so quantities and
exceptions in one document are not discarded as duplicates. Only identical excerpts
within a document are deduplicated. Evidence budgets retain complete source snippets.
See [Assistant templates](assistant-templates.md) for defaults and scope overrides.

Preview search accepts optional `policy: {semanticThreshold, maxSources, contextChars}`
and retains the existing `data` array. Its additional `diagnostics` explains empty
scope (without claiming an untested model is missing), no hits, missing model, absent compatible indices or embedding failure with
keyword fallback. Counts include scoped chunks, compatible/scanned/stale vectors,
candidate counts, invalid or mismatched vector dimensions, selected excerpts, excerpt characters, duration and policy.
Automatic chat records the initial retrieval diagnostics in message metadata,
including turns with no sources; they survive reload and backup. Tool search returns
its own diagnostics with its output. Diagnostics never assert that a model answer
is correct and do not contain query or document text.

### Explicit quality evaluation

Open **检索质量评测** in the document library, replace the example questions with
representative cases from your own documents, and optionally choose an assistant
template. Run retrieval alone, enable **同时生成回答**, or additionally enable
**模型语义评审**. The latter sends the generated answer, retrieved excerpts and
scoring criteria to a chat model for another potentially billed call per question.
The UI confirms the data flow and fees. It defaults to reviewing with the answer
model, so this is not an independent reviewer. The API can explicitly select a
different allowed chat model. Model fallback can cause additional provider attempts.
No tools or long-term memories are used. Template-loading failures are visible and
can be retried; default-model evaluation remains available.

`POST /api/documents/evaluate` requires `confirm: true`, optional `generateAnswers`
(default false), optional `judgeAnswers` (default false, requires answer generation),
optional `judgeModel: {providerId, modelId}` (requires judging; existing chat-model
allowlist/credentials apply), optional `assistantTemplateId` or `policy` (mutually exclusive),
and 1–12 `cases`. Each case contains `question`, optional `collections`,
`expectedFilenames`, `requiredFacts`, optional `expectations` (up to 12 objects with
`kind: fact|condition|exception|quantity|conflict` and a complete `statement` of at
most 400 characters), and `answerable` (default true). An unanswerable
case must leave expected documents, facts and expectations empty. Explicit case collections
override template collections for that evaluation; normal chat uses its own saved scope.

The returned report includes each case's actual excerpts, diagnostics, filename
recall, exact-text fact coverage in evidence/answer, matching citation count,
unknown knowledge links, generated text, response model ID and timing. Missing
expectations produce null metrics. Expected facts, filenames and typed expectations
never reach the answer-generation prompt. Facts and expectations are supplied only
to the separate judge. Per-case failures retain retrieved
evidence and report a failure instead of fabricating an answer. Calls are sequential,
have no SDK retries, and obey existing model admission, fallback and usage recording.
Attempts appear under embedding and tool usage; costs are unknown unless the provider
or configured rates report them, not assumed free. The report's model names the
requested model; `responseModelId` and usage records identify actual responses.

The endpoint allows two runs/minute, caps the request at two minutes and each
answer/judge call at thirty seconds, and propagates cancellation. Judge output is
bounded to 6,000 tokens and answer output to 1,500. Twelve questions can exceed the
overall deadline, especially with review enabled; use smaller batches rather than
expecting every maximum-sized run to finish. Already-sent calls may
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

Document search and automatic chat context use the same hybrid retrieval. Preview
search does not call a chat model. The library's collection selector uses
exact names, including names containing `|`. `POST /api/documents/search` accepts
optional `collections` (up to 12 names of 40 characters); omitted or empty means
all collections. Chat and tool retrieval continue using the stored conversation
scope. Results distinguish `local-keyword`, `semantic`, `hybrid` and `neighbor`,
and include section paths, matched terms, collection and document content hash.
These explain how a fragment was selected, not a probability
that it answers the question. A keyword overlap can be useful yet contain no answer.

The model prompt requires applying and combining evidence, preserving quantities,
units, prerequisites and exceptions, citing supported claims, disclosing conflicting
documents and stating when evidence is insufficient. Empty retrieval has an explicit
instruction against inventing knowledge-base facts. This directs the model; it does
not guarantee compliance. Answer sources show whether the generated Markdown actually
links to each versioned snippet. **回答已引用此片段** means a link was present, not
that its associated claim was verified. **回答未引用此片段** identifies retrieved
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
