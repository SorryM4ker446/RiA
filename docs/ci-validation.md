# Validating changes against GitHub Actions

The workflow in [ci.yml](../.github/workflows/ci.yml) is the source of truth.
Before investigating a failed run, read the failed job's logs and retained
diagnostics, including the checked-out merge commit and runner image. A local
checkout may contain changes that the failed run never tested.

The current jobs use Windows runners, Node 24.9.0 and npm 11.19.1. Each Node job
pins npm before installing dependencies or running scripts. `packageManager`
alone does not change the npm bundled with Node. `windows-latest` is a moving
runner image; matching Node and npm locally does not reproduce Windows Server,
installed tools, policy, cold caches or runner performance.

For a local reproduction, use a disposable checkout with the candidate changes,
close other builds and application processes, and run in PowerShell:

```powershell
node --version # Must report v24.9.0
npx --yes npm@11.19.1 --version
$env:CI = 'true'
$env:APP_RUNTIME = 'test'
$env:LOCAL_DATABASE_FILE = ".desktop-data/ci-local/$([guid]::NewGuid())/app.db"
$env:OPENROUTER_API_KEY = ''
$env:DEEPSEEK_API_KEY = ''
$env:TAVILY_API_KEY = 'test-tavily-key'
$env:TAVILY_SEARCH_URL = 'http://127.0.0.1:4010/search'
npx --yes npm@11.19.1 ci
npx --yes npm@11.19.1 audit --audit-level=low
npx --yes npm@11.19.1 run db:generate
npx --yes npm@11.19.1 run db:check
npx --yes npm@11.19.1 run lint
npx --yes npm@11.19.1 run typecheck
npx --yes npm@11.19.1 run test:db
```

Stop on any nonzero exit. `npm ci` removes installed dependencies; do not run it
while another process is using that tree. Audit uses the current advisory
database, so an unchanged lockfile can fail after a new advisory or affected
version range is published. Repair the affected dependency and retain the audit
gate rather than ignoring it.

Run the three server shards with the workflow's test concurrency and empty
provider keys; check each exit status:

```powershell
$env:TAVILY_API_KEY = ''
foreach ($shard in 1..3) {
  node --import ./tests/helpers/register-typescript.ts --test --test-concurrency=2 --test-shard="$shard/3" tests/server/*.test.ts
  if ($LASTEXITCODE) { throw "Server shard $shard failed" }
}
```

For browser validation, restore the fixture search configuration and use the
production-build harness, two workers per shard and zero retries. CI runs three
independent browser shards with `fail-fast: false`; the validation gate requires
every shard to pass. Each shard builds its own runtime and uploads a uniquely
named diagnostic artifact on failure. This reduces the longest job without
sharing mutable databases, build directories or browser state between runners.
Do not reuse a local development server or run another build/desktop smoke
concurrently in the same checkout:

```powershell
$env:TAVILY_API_KEY = 'test-tavily-key'
npx --yes npm@11.19.1 exec -- playwright install chromium
npx --yes npm@11.19.1 run test:e2e:diagnostics
npx --yes npm@11.19.1 run test:e2e
```

The full local command covers the same cases without sharding. To match a CI
shard, append `-- --shard=1/3` (or `2/3`, `3/3`). To check shard coverage without
building, use `npm run test:e2e -- --list --shard=1/3` for each shard and compare
their union with the unsharded list. The shards must have no missing or duplicate
test cases. Hosted wall-clock improvements still require a new Actions run;
parallel shards use additional runners and repeat installation/build overhead.

The browser harness creates a separate database/media directory for each run.
It explicitly sets its runtime environment; the server tests use isolated
fixtures too. Targeted browser cases are useful during repair, but do not replace
the full browser gate. Retain traces and screenshots from the first failure.
The desktop job has its own runtime provisioning, smoke, installer and manual
acceptance gates; application/browser checks do not certify those results.

Tests should synchronize on the contract being exercised. Attachment checks
wait for the upload response before checking the rendered attachment. Terminal
checks require a visible stop control, since text assertions alone can match
output inside a collapsed disclosure. Saved summaries can arrive before full
tool details: delayed terminal details must gain their automatic expansion while
preserving explicit mouse and keyboard choices. These transitions are covered
without longer timeouts or retries.

The recently edited files summary appears only after the reply finishes. Its
browser test consumes the submitted chat stream and waits for the composer to
leave its busy state before checking the summary. Terminal work on the hosted
runner can outlast the UI assertion budget while the tool is still running.
Keep the turn's overall timeout and all file, persistence and desktop
bridge assertions; do not start a finished-result assertion at submission time.

Database persistence is not stream completion. Before restarting a fixture
server, consume the chat continuation, wait for the composer to leave its busy
state and unload the page. The extension discovery regression holds the final
stream flush after persistence to exercise this boundary deterministically.
Long terminal commands keep their complete text in the DOM, grouped into blocks
whose offscreen layout is deferred. Browser checks retain the multi-megabyte
transport and command hashes, verify native selection hashes and scroll to the
last block; rendering optimization must never truncate approval or saved input.

Native selection forces Chromium to lay out the complete script. Its checks for
two saved multi-megabyte commands run independently at desktop and narrow widths,
using saved-history fixtures. The real terminal integration still verifies two
approvals, complete transport and persisted/DOM hashes, reload and follow-up
context. Keep these contracts covered without accumulating all layout work in
the real execution case's timeout budget. Intermediate persistence checks read
the isolated database directly, avoiding repeated multi-megabyte transfers
through `page.evaluate` and the trace recorder. Reload still reads the complete
HTTP history and verifies both rendered command hashes.

PDF extraction disables canvas's automatic system/user font discovery inside
the parser worker. PDF.js's `useSystemFonts: false` applies after canvas module
initialization and does not prevent that scan. The worker continues to use
bundled PDF fonts and the existing parse/cleanup limits. A regression rejects
any host font enumeration while extracting real PDF text. Parser timeout logs
include only the format and a fixed phase (startup, PDF module import, document,
text or cleanup); inspect those alongside the desktop smoke failure before
attributing another 504 to runner speed. A local pass does not establish the
cause of an intermittent hosted timeout.

Animation checks synchronize with committed DOM state and sample the real CSS
transition at a controlled point on its Web Animations timeline. A fixed number
of animation frames does not guarantee positive elapsed animation time on a
hosted runner. The approval disclosure regression still requires a real height
transition, an intermediate height strictly between the collapsed and expanded
states, reduced-motion behavior, keyboard toggling and narrow-screen controls.
An additional Chromium case uses CPU throttling to exercise slower rendering;
this simulation is separate from validation on the actual hosted runner.

Report local commands, environment, scope and failures separately from hosted
Actions results. Only a new successful hosted run establishes that GitHub
Actions passed. Changes remain unpublished until the repository owner submits
them.
