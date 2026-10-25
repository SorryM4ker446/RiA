# Document processing and export

Open **Knowledge → document details** to read a document, choose **Export** for a format,
or choose **Edit copy** to revise extracted content before downloading it.
Knowledge import accepts PDF, Word `.docx`, UTF-8 Markdown and TXT. It uses
the bounded local extraction worker: up to 8 MiB, 200 PDF pages and 100,000
extracted characters, with a 30-second parse deadline.
Corrupt, encrypted, scanned-only and oversized documents fail visibly. OCR and
legacy `.doc` are not supported.

The detail page defaults to original-text reading with two compact actions.
Editing reveals content/preview tabs; filename and content-type settings remain
collapsed under **Export options**. The editable copy lives only in the current page;
download it before leaving. It does not update the stored document, search index
or citations, and requires no model call. Returning to the original retains the
copy until navigation. Failure and cancellation preserve edits; an obsolete source
read cannot overwrite a newer copy. Citation anchors return to original text.

The independent document-processor navigation entry and workspace are removed.
Existing `/document-processor` links redirect to the knowledge library; links
with a `document` parameter redirect to that document's detail page.

## Conversion and preview

Choose **Markdown structure** to interpret headings, emphasis, lists, tables, code,
links and footnotes, or **Plain text** to preserve literal Markdown characters.
Word uploads escape literal symbols while retaining extracted heading/list/table
structure; existing knowledge documents use their already extracted text.
Review that representation and change the content type when needed.

Exports are generated on demand as Markdown, TXT, HTML or Word `.docx`.
**Export** downloads the displayed source version, refusing changed/deleted sources.
**Export copy** downloads current edits without changing the knowledge document.
Markdown preserves Markdown source; plain text exported to Markdown escapes
formatting punctuation. TXT renders Markdown
structure as readable text and tab-separated table rows. Word includes A4 page
settings, heading styles, emphasis, real numbered/bulleted lists, code paragraphs
and table headers/cells. HTML includes standalone document styling and UTF-8.
No Microsoft Office installation is required for export.

Conversion uses text structure, not the original visual layout. Images, original
pagination, headers/footers, merged cells and complex formatting are not preserved.
PDF extraction order needs human review. External images remain descriptions and
URLs; RiA does not download them. Raw HTML is escaped as literal text. HTML links
permit HTTP(S)/mailto only, and HTML exports carry a restrictive content policy.
The preview runs in an iframe without script, form or same-origin permissions.
Styles remain confined to that frame.

Exports accept at most 100,000 characters and 20,000 syntax nodes, with nesting
limited to 32 levels and tables to 2,000 rows / 64 columns. Output is capped at
8 MiB. Invalid Unicode/control characters fail before generating XML or filenames.
Generated files are not stored on the server; there are no new persistent tables,
artifact directories or backup formats to migrate.

## Chat tools

The existing unified registry exposes two additional built-in tools:

| Tool | Behavior |
| --- | --- |
| `readDocument` | Read a knowledge document by `documentId`, with `offset` and `limit` (default 6,000, maximum 12,000 UTF-16 characters); returns page excerpts, a content version and `nextOffset` |
| `convertDocument` | Prepare a download for a knowledge document as `md`, `txt`, `html` or `docx`; returns a version-bound URL and a download button |

The model can find document IDs through `searchKnowledge`. Both tools obey the
conversation's document collections, assistant tool allowlist, shared execution
records and run/step budgets. The tool picker lists the actions **Read document** and
**Convert and export document**, not document IDs or filenames. After selecting an action,
choose its document parameter by filename from the current topics;
the internal ID is supplied automatically. An explicit action runs once and
returns to automatic tools on success, without changing which tools the model
can use in subsequent chat. Failure retains the selected document and format.
They do not read arbitrary filesystem paths, write files to granted folders or
upload content. File saving happens when the user clicks download. Model-assisted
chat remains subject to normal provider usage; editing and export in document
details require no model key.

Downloads in chat survive service restart while that source version exists. A
changed source returns 409 and requires a fresh conversion; a deleted source
returns 404. Download errors stay in chat instead of saving an error response as
a Word file. Document details provide the same formats directly.

## Local API

All endpoints use the existing local session, Host/Origin checks and restore gate.

| Endpoint | Request / result |
| --- | --- |
| `POST /api/document-processor/parse` | Multipart `file` only; 9 MiB envelope; returns extracted pages, editable content, content syntax and limitations |
| `POST /api/document-processor/export` | JSON `{ filename, content, syntax, format }`, at most 1 MiB; returns attachment bytes with UTF-8 filename metadata |
| `GET /api/document-processor/source/:id` | Current full extracted knowledge document, without original file bytes |
| `GET /api/documents/:id/export?format=docx&version=<hash>` | Download exactly the named source version; unsupported or duplicate parameters fail |

Parsing shares the existing document-preview quota of six attempts per minute.
Exports and layout previews share 20 attempts per minute. Built-in tool execution
also uses the existing tool quota. There are no automatic conversion retries.

## Verification

Server regressions exercise real PDF/Word extraction and DOCX read-back, Unicode,
literal markup, table cell relationships, invalid/oversized files, cancellation,
authentication, quotas, scoped tools and version changes. Production-renderer
tests cover all four copy downloads, version-bound original downloads, the isolated
preview, compact narrow layouts, legacy redirects, citation navigation, failure
recovery, obsolete responses and chat downloads across restart.
Electron smoke also downloads a Word file through the actual renderer's blob
download, then submits those bytes to the parser to verify retained table values.
Browser provider responses are offline fixtures; they do not prove live-model tool selection quality
or exact visual fidelity in every Word editor. Chromium may report rejected
automation-recorder injection into the intentionally script-free preview frame;
tests separately require no executable content or remote-image requests.

Implementation references: [Markdown syntax tree parser](https://github.com/syntax-tree/mdast-util-from-markdown),
[GFM extensions](https://github.com/syntax-tree/mdast-util-gfm),
[WordprocessingML structure](https://learn.microsoft.com/en-us/office/open-xml/word/structure-of-a-wordprocessingml-document).
