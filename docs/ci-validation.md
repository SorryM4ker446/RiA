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
production-build harness, two workers and zero retries. Do not reuse a local
development server or run another build/desktop smoke concurrently:

```powershell
$env:TAVILY_API_KEY = 'test-tavily-key'
npx --yes npm@11.19.1 exec -- playwright install chromium
npx --yes npm@11.19.1 run test:e2e:diagnostics
npx --yes npm@11.19.1 run test:e2e
```

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
