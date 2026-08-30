import assert from "node:assert/strict";
import { createRequire, registerHooks } from "node:module";
import { test } from "node:test";

const require = createRequire(import.meta.url);

for (const [specifier, exportedName] of [["next/server", "NextRequest"], ["next/headers", "headers"]]) {
  test(`test loader resolves ${specifier} for ESM and CommonJS without re-entering its hooks`, async () => {
    let depth = 0;
    let visits = 0;
    const guard = registerHooks({
      resolve(candidate, context, nextResolve) {
        if (candidate !== specifier) return nextResolve(candidate, context);
        visits += 1;
        depth += 1;
        try {
          assert.equal(depth, 1, "Resolving a Next entrypoint must not restart the hook chain");
          return nextResolve(candidate, context);
        } finally { depth -= 1; }
      },
    });
    try {
      const imported = await import(specifier);
      assert.equal(typeof imported[exportedName], "function");
      assert.equal(require.resolve(specifier), require.resolve(`${specifier}.js`));
      assert.equal(require(specifier)[exportedName], imported[exportedName]);
      assert.ok(visits > 0, "The import must exercise the registered resolver");
    } finally { guard.deregister(); }
  });
}
