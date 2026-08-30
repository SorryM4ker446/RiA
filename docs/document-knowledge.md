# Document knowledge

Open **知识库管理 → 文档知识库** to import a PDF, UTF-8 Markdown (`.md`), UTF-8 text (`.txt`) or Word `.docx` file. The original file is not retained: SQLite stores the extracted text, filename, PDF page numbers and a local search index. Keep the original separately if you need its formatting or binary contents.

Importing a file with the same exact filename updates that user's document. Identical extracted text leaves the index unchanged; changed paragraphs add/remove chunks while unaffected chunks keep their IDs. **重新索引** rebuilds the search terms from the saved text. It does not rerun file extraction; import the original again to apply a parser change. Reindex after a runtime upgrade if its Unicode segmentation has changed. Index replacement is transactional, so validation failures and failed writes preserve the working version.

The document panel provides local search without requiring a model key. Chat automatically retrieves up to four relevant snippets; the knowledge-search tool also combines document results with existing memories and built-in notes. Filenames, excerpts and source links appear below the answer. PDF sources identify their page; other formats identify their chunk. Sources are retrieved evidence, not a guarantee that the model used every excerpt or answered correctly. The source page requires the same authentication as the knowledge library and renders extracted text rather than document HTML.

## Privacy and retention

Import and document search run locally and do not call an embedding service. When you ask a chat question, retrieved excerpts are sent to your configured model with the conversation. Imported text is marked as untrusted reference data in the prompt; this is not a guarantee against every model prompt-injection attack. Do not import material you are unwilling to share with that model when relevant to a question.

Deleting a document removes its saved text and search index. Existing chat citation snapshots, answers and tool memories can still contain excerpts or facts from the document; delete those separately when needed. A link to a deleted document reports that it is unavailable. If an individual chunk changed, its old link explains that the current document differs while the chat retains the earlier excerpt. Backups can also retain deleted content; this is logical deletion, not secure disk erasure.

Document data lives in the existing SQLite database, not `public/` or a new filesystem directory. Existing SQLite backup procedures include it. A complete application backup must still include the private media directory for images/videos. Desktop startup backs up an existing database before applying the document migration; back up manually before applying migrations through the Web CLI. No model, storage or cloud-service configuration is needed for importing or searching documents.

## Bounds and supported content

| Boundary | Limit |
| --- | --- |
| Upload | One file, 8 MiB; 9 MiB multipart request, counted from the actual stream |
| Stored text | 100,000 UTF-16 code units per document |
| PDF pages | 200 |
| Chunks | 256 per document; at most 1,000 code units with 100-character overlap within long paragraphs |
| Documents | 100 per user |
| Import and reindex | Shared per-user quota of 6 attempts/minute |
| Parsing | At most two workers per service; 15-second deadline; 128 MiB old-generation JS heap per worker |
| Word archive | 500 non-directory entries; at most 12 MiB of actual decompressed data |

Workers receive no inherited environment variables, use buffer input and have `fetch` disabled. PDF JavaScript evaluation and image rendering are disabled; Word import extracts raw text and does not enable external-file access. The heap limit does not cap all native allocations; these controls bound common local resource abuse and are not an OS sandbox for hostile public uploads. Existing media and Proxy body limits are unchanged.

Scanned/image-only PDFs need OCR before import. Encrypted PDFs, legacy `.doc`, macro-enabled Word, arbitrary binary text and malformed files are rejected. No OCR, original-file download, table-layout preservation, automatic background parsing or semantic document embeddings are provided. Complex layouts/fonts may extract imperfectly; inspect the source page before relying on them.

Document search uses the shared Chinese word segmentation, Unicode normalization and stop words, then a SQLite inverted index. Up to 16 query terms select 200 candidates across all owned documents. Coverage, exact phrase and filename matches determine ranking, with stable ties and at most two chunks per document. It is lexical retrieval; synonyms and facts beyond retrieved chunks may be missed.

## API and validation

| Endpoint | Contract |
| --- | --- |
| `GET /api/documents` | Current user's bounded document summaries; no query parameters |
| `POST /api/documents` | Multipart `file`; returns `data.document`, `change`, `added`, `retained`, `removed`; HTTP 201 for creation, 200 for updates/unchanged content |
| `GET /api/documents/:id` | Owned summary and extracted chunks; no raw original file |
| `POST /api/documents/:id` | Reindex saved text; empty body or `{}` |
| `DELETE /api/documents/:id` | Delete saved document and index; empty body or `{}` |
| `POST /api/documents/search` | JSON `{ "query": "search terms" }`, 1–2,000 characters; up to six source snippets; shares the tool request quota |

All endpoints use the existing [authentication, Origin and error contracts](api-security.md). Foreign and missing document IDs return the same 404. Parser capacity returns 503 with `Retry-After`; parsing deadline returns 504. Import quota exhaustion returns 429. Oversized files, extracted text, archives or chunk counts return 413.

`tests/fixtures/document-retrieval.json` is the minimal fixed evaluation corpus: six source documents and eight Chinese/English questions, supplemented with forty newer distractors in the test. `npm run test:server` reports Recall@3 and MRR@3 and requires both to remain 1.0 for this small corpus. This is a regression baseline, not a claim about arbitrary document accuracy.

PDF.js, Mammoth and JSZip are application dependencies, pinned in the lockfile. The worker uses native Node resolution because bundler module IDs are not filesystem paths. Next's output tracing explicitly includes these packages and their installed runtime dependencies, including PDF character maps/fonts and the optional platform canvas binding when present. Keep that tracing synchronized when upgrading parsers. Browser integration tests import actual generated PDF/DOCX files through the production standalone service; Electron smoke tests repeat binary imports and verify text/index retention after service restart. No paid provider is used by these checks.
