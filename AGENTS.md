# Codex Collaboration Rules

These rules apply to all Codex work in this repository.

- Continue work on the `codex` branch by default. Do not create or switch to another branch unless the user explicitly approves it.
- Do not run `git commit`, `git push`, create or merge a pull request, or otherwise publish changes. The user performs all of these operations manually.
- After each requested change, run the relevant validation, summarize the changes and results, and stop for user acceptance before any repository history or remote operation.
- After completing a feature, review whether automated tests, deployment artifacts, CI workflows, configuration examples, or related operational documentation must change with it. When updates are needed, include them before the development task is considered complete and validate the synchronized result.
- Keep internal planning labels private to local planning material. Do not include them in source code, test names, code comments, public documentation, commit messages, or pull request descriptions. Describe observable behavior and actual functionality instead.
- Preserve unrelated user changes and never overwrite or discard them.
- Do not record real passwords, database connection strings, signing secrets, or other credentials in repository files, logs, or handoff notes.


<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
