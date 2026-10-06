# Dependency security backports

These private packages contain the original upstream source and licenses plus the patches described below. They are installed through npm `overrides` under the original dependency names. They are not published. CI still runs the complete `npm audit --audit-level=low`; there is no advisory allowlist or severity exception. A zero audit result for a private fork is not evidence that the patch works: the behavioral regressions in `tests/server/dependency-security.test.ts` validate the changes and their installed consumers.

## braces

Source: `braces@3.0.3`, https://github.com/micromatch/braces/tree/3.0.3. MIT license retained. Original registry tarball integrity: `sha512-yQbXgO/OSZVD2IsiLlro+7Hf6Q18EJrKSEsdoMzKePKXct3gvD8oLcOQdIzGupr5Fj+EDe8gO/lxc1BzfMpxvA==`.

[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) has no upstream patched release as of 2026-10-06. The parser rejects nesting beyond 128 stack levels before constructing deeper trees. Compile, expand and stringify validate caller-supplied ASTs iteratively before recursive traversal, rejecting depth above 128 and bounding node visits to 20002 (twice the upstream character limit plus root/end nodes). Valid shallow patterns preserve upstream matching and expansion behavior. The upstream range-expansion limit remains intact.

## sprintf-js

Source: `sprintf-js@1.1.3`, https://github.com/alexei/sprintf.js/tree/1.1.3. BSD-3-Clause license retained. Original registry tarball integrity: `sha512-Oo+0REFV59/rz3gfJNKQiBlwfHaSESl1pcGyABQsnnIfWOFt6JNj5gCog2U6MLZ//IGYD+nA8nI+mTShREReaA==`.

[GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) has no upstream patched release as of 2026-10-06. Numeric `%e`, `%f` and `%g` precision is saturated at the ECMAScript maximum of 100. `%g` precision is at least one. This makes unsupported precision values produce bounded numeric output instead of native `RangeError`; ordinary supported precision and other formatting behavior remain unchanged. It does not catch or suppress unrelated formatting errors.

## Maintenance and packaging

Keep these directories, licenses, `.npmrc` and lockfile entries together. A clean checkout must contain `vendor/` before running `npm ci`. The project enables `install-links` so npm installs local dependencies as physical packages rather than symlinks outside `node_modules`. Direct dependencies and matching `$` overrides ensure transitive consumers receive the same patched implementation. Third-party source is excluded from application ESLint conventions and has dedicated security and compatibility tests. The production `sprintf-js` backport must be physically copied with its license into the standalone runtime; development dependencies must not be assumed available on an installed machine.

Increment the private package version and regenerate the lockfile whenever a backport changes, then verify a clean installation; an existing installed copy is not authoritative evidence of updated local source. When upstream publishes a fix, replace the matching override with the upstream version, remove its private source, and rerun audit, clean installation, consumer regressions and Windows packaging. Do not remove the overrides merely because an audit report is clean.
