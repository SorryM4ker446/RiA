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

## Project-wide Engineering and Acceptance Principles

These principles apply to features, bug fixes, refactoring, performance work, dependencies, configuration, CI, deployment, migrations, and operational tooling.

Apply them **in proportion to the scope, risk, blast radius, reversibility, and shared impact of the change**. Small, isolated changes should remain lightweight. Shared, persistent, security-sensitive, concurrent, operational, or difficult-to-reverse changes require deeper investigation and validation.

Do not investigate, redesign, or refactor unrelated systems without evidence that they are affected. A locally successful result is not sufficient evidence of a correct system change.

### 1. Understand the contract before changing the system

Before implementation, establish enough of the following to make the change safely:

- the intended outcome and acceptance criteria;
- the current behavior that must remain valid;
- the authoritative sources of data, state, and ownership;
- the relevant interfaces, callers, consumers, and lifecycle;
- the likely blast radius of the change.

Trace the relevant flow across components or services when the behavior crosses those boundaries. Do not reason only from the file, symptom, screenshot, failing test, or endpoint presented.

Distinguish clearly between:

- observed facts;
- confirmed causes;
- hypotheses;
- unverified assumptions.

For a bug, identify the mechanism producing the failure before selecting the remedy.

For a feature or refactor, understand how the change fits the existing architecture, ownership model, and lifecycle before introducing a new mechanism.

Do not optimize for making a screenshot, endpoint, demo, test, or immediate task appear successful while leaving the underlying contract unresolved.

Preserve established behavior unless changing it is part of the requested outcome. Make material behavior changes and important design tradeoffs explicit.

### 2. Prefer one coherent source of truth and the simplest design that satisfies the contract

Reuse established mechanisms when their contracts fit the requirement.

Avoid introducing:

- competing sources of truth;
- unnecessary duplicated state;
- hidden synchronization;
- fragile execution-order dependencies;
- abstractions that exist only to compensate for another workaround.

Every new abstraction, dependency, state store, cache, background task, timer, retry, flag, fallback, listener, or queue should have a clear purpose, owner, lifetime, and failure behavior.

If successive patches require additional synchronization, fallback logic, or compensating layers to remain correct, reconsider the underlying design rather than adding another patch.

Core correctness must not depend on:

- an optional optimization;
- cache persistence;
- arbitrary timing assumptions;
- local-machine defaults;
- accidental environment behavior.

Prefer the smallest coherent change that resolves the underlying requirement without creating unnecessary architecture.

### 3. Design the relevant lifecycle, not only the happy path

For the affected flow, consider the states that materially apply:

- initial;
- loading or in progress;
- normal success;
- empty or absent data;
- partial completion;
- failure;
- retry or recovery;
- cancellation;
- cleanup.

Where relevant, also account for:

- duplicate operations;
- concurrent updates;
- delayed or out-of-order work;
- stale requests or obsolete jobs;
- process restarts;
- dependency outages;
- version changes;
- long-lived execution.

For writes, define transaction, consistency, ownership, and idempotency boundaries where they matter.

Prevent stale or obsolete work from modifying newer state, identities, requests, or targets.

Retries must not duplicate writes. Cache expiry must not corrupt authoritative state. Cancellation and replacement must not leave obsolete work able to commit later.

Keep resource use bounded where materially relevant. Avoid unbounded work or retention, and ensure owned resources are cleaned up across success, failure, cancellation, replacement, and teardown.

Do not hide unresolved failures with:

- arbitrary delays;
- suppressed exceptions;
- misleading success responses;
- visual masking;
- unnecessarily expanded caches;
- disabled safeguards;
- weakened tests;
- excessive retries.

A mitigation is not a resolution. If a workaround is necessary, identify it as such and make its limitations clear.

### 4. Validate contracts and failure modes, not merely implementation details

Choose verification from the requirements, affected contracts, and realistic failure modes rather than from the implementation alone.

Test the boundaries that materially apply, such as:

- empty or malformed input;
- authorization or permission changes;
- repeated execution;
- realistic data sizes;
- dependency failure;
- expiry;
- retries;
- interruption;
- concurrency;
- stale or out-of-order work.

Prefer regression tests that would fail for the original defect and pass because the underlying behavior is now correct.

Do not:

- remove useful assertions;
- weaken expectations;
- inflate timeouts;
- add arbitrary retries;
- alter expected behavior solely to obtain a passing result.

When an existing expectation is genuinely obsolete, replace it only when the intended contract justifies the change.

Verify the affected workflow at the level appropriate to the change. Depending on the system, this may include:

- unit or integration behavior;
- API contracts;
- browser transitions and intermediate UI states;
- database consistency;
- restart or migration behavior;
- deployment or configuration checks.

Verify meaningful intermediate states when they affect correctness, not only the final result.

A correct screenshot, successful HTTP response, passing unit test, successful build, or successful local run alone does not establish end-to-end correctness when broader behavior is affected.

### 5. Check shared impact conditionally

Inspect related project artifacts when the change affects them. Do not treat this as a mandatory checklist for unrelated changes.

Examples:

- dependency changes → manifests and lockfiles;
- configuration changes → defaults, examples, secrets handling, deployment configuration;
- persistent-data changes → schemas, migrations, upgrades, recovery, rollback constraints;
- CI or build changes → workflows and generated artifacts;
- public behavior changes → compatibility and documentation;
- operational changes → deployment, monitoring, recovery procedures, or runbooks.

When shared modules or contracts change, check materially affected consumers.

For changes that can affect existing data or running deployments, consider compatibility, upgrade behavior, recovery, and rollback before declaring readiness.

Do not broaden the task merely because adjacent artifacts exist.

### 6. Stop when the evidence is sufficient

Do not expand the task indefinitely.

Stop when:

- the requested behavior and acceptance criteria are satisfied;
- affected contracts have been verified at a depth proportional to the change;
- no known failure remains within the authorized scope;
- required supporting artifacts are synchronized;
- remaining uncertainty is either immaterial or clearly reported.

Do not perform unrelated refactoring, cleanup, redesign, or speculative improvements solely because nearby code could be improved.

If a broader issue is discovered outside the requested scope, report it separately unless it must be addressed for the requested change to be correct.

Do not keep searching for theoretical edge cases once the relevant contract is adequately established and tested.

### 7. Report completion according to evidence

Completion claims must match the evidence actually obtained.

Report the materially relevant parts of:

- what changed;
- what was verified;
- compatibility or operational impact;
- remaining uncertainty;
- known risks;
- external blockers.

Distinguish clearly between:

- code inspection;
- local execution;
- automated tests;
- simulated conditions;
- real CI results;
- deployment or production validation.

Never present one form of evidence as another.

Do not declare the work complete while a known failure of the requested behavior remains.

If an external constraint prevents full completion, identify the constraint and the remaining work rather than presenting a partial result as a full fix.

Passing a narrow test suite does not override a known system-level problem.

### Operating Rule

Use engineering judgment rather than maximum ceremony.

The goal is not exhaustive investigation or maximum process. The goal is to make the requested change **correct, coherent, maintainable, proportionate to its risk, and supported by sufficient evidence**.

When correctness and scope discipline conflict with speculative improvement, prefer correctness and scope discipline.