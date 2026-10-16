# Knowledge topic workspaces and cited artifacts

Open **知识专题** in the sidebar, select 1–12 named document collections and optionally choose a default assistant. Topics reference the existing library; documents and vectors are not copied. An empty collection remains empty, rather than expanding retrieval to the entire library. Up to 50 topics can be stored.

The workspace shows collection documents, local and semantic index coverage, scoped retrieval, topic conversations and artifact history. Use **管理资料与索引** to import documents or repair their indices. Retrieval uses the existing hybrid RAG pipeline and the assistant's retrieval policy. Without usable vectors it retains the existing lexical fallback and reports diagnostics; unrelated collections are never added as a fallback.

New topic conversations snapshot the current template and use the topic's collections, overriding the template's default collections. Editing a topic or template does not change existing conversations. Users can explicitly adjust a conversation's settings afterward. Deleting a topic removes its artifacts and unlinks its conversations, preserving library documents and conversation history.

## Generating and checking artifacts

Choose a report, plan or summary, supply a title and instructions, and explicitly authorize model calls. Retrieval may call the configured embedding model; generation calls the template's bound chat model or the current default chat model. Questions and retrieved document excerpts are sent to those providers and may incur charges. No personal memories or execution tools enter artifact generation.

The service saves a request record before retrieval, up to eight evidence excerpts, retrieval diagnostics, topic and assistant snapshots, selected and response model identities, and the generated Markdown. The prompt asks for claims with source links, original conditions and units, exceptions, conflicts and explicit uncertainties. No evidence means a failed record without a chat generation call. Missing supplied citations or unknown Markdown links mark output as **引用待检查**. Even **已生成** means generation and link checks succeeded; it does not establish that every factual claim is supported. Review the content before using it.

Source links carry a document hash and chunk identifier. The workspace keeps the original evidence snapshot and reports current/changed/deleted source status through the existing provenance viewer. A document or topic change during generation invalidates the result instead of saving stale output. Later changes do not rewrite completed artifacts.

Markdown export includes the body, state, model, topic revision and evidence snapshots; JSON export includes full saved metadata and diagnostics. Exports contain document excerpts and should be shared accordingly. Failed, interrupted or still-generating records have no exportable body.

## Cancellation, recovery and bounds

Each generation has a client UUID and a hash of the request. Repeating the same saved request reads its record without another model call; reusing its UUID with different input fails. The UI never automatically retries generation. If the response is lost, use **刷新专题和成果** to read the record. Clicking **生成成果** again is an explicit new request and may incur another charge.

Cancel stops the owned request and marks an unfinished record cancelled. A call already sent to a provider may still be charged; cancelling cannot undo a committed artifact. Navigating away aborts in-flight page work. On service restart, previously generating records become interrupted when read, without replaying the call. Model errors preserve failed records; active work prevents deleting its topic or artifact.

Generation has a 60-second deadline, at most two simultaneous jobs in the single local service and one per topic, four generation requests per minute, 3,000 output tokens and 30,000 saved characters. History is bounded to 50 artifacts per topic and 200 overall; delete unneeded records before generating more. Conversation history displays the latest 50 topic conversations; older conversations remain accessible from the general history. No background queue or periodic polling is introduced.

## Upgrade and backup

The additive SQLite migration creates `knowledge_topics` and `knowledge_artifacts` and adds nullable `chats.topicId`. Normal application startup applies the migration; existing conversations retain their settings. No dependency, secret or environment variable is added.

Workspace backups include topics, artifacts, associated conversations and evidence snapshots. Restore remaps topic, template, document and chunk references, including generated source links, while retaining the original document hash and literal excerpts. Restored generating records become interrupted. Vectors follow the existing backup policy and must be rebuilt as needed after restore; saved artifact evidence remains readable.

This version reads older backups with absent topic/artifact fields as empty lists and absent conversation topic IDs as null. Restore replaces the workspace, so restoring an older archive also removes current topics and artifacts; the confirmation displays their counts and the existing safety backup is retained. Older application versions are not guaranteed to read archives containing the new fields. Keep a pre-upgrade backup for rollback; do not delete migration records or drop live tables to downgrade.

## Acceptance

1. Create a topic containing one collection; confirm unrelated documents do not appear in its retrieval or generation prompts.
2. Start a topic conversation, then edit the topic; confirm the conversation retains its original scope and template snapshot.
3. Generate a summary containing a documented condition and exception. Open its citations and verify the actual claims; inspect both export formats.
4. Change or delete a cited document afterward; the artifact retains its original excerpt and reports the source change.
5. Cancel generation or restart the service; refresh history and confirm no automatic replacement model call occurs.
6. Backup and restore; verify remapped conversations and citations and interruption of previously pending artifacts.

Offline automated fixtures verify transport and lifecycle, not real-model factual quality. Repeat claim and citation checking with your configured provider and actual library. Windows installer/VM acceptance remains a separate deployment check.
