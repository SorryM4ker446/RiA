import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { makeDesktop } from "../../scripts/make-desktop.mjs";

test("installed WiX is available to child builds without changing the caller's environment", () => {
  const environment = { Path: "original-path" };
  const calls: Array<{ args: string[]; env: Record<string, string> }> = [];
  makeDesktop("fixture root", { platform: "win32", environment, exists: () => true,
    run: (_command, args, options) => calls.push({ args, env: options.env }),
  });
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.env.PATH, `${join("fixture root", ".desktop-data", "tooling", "wix-3.14.1")};original-path`);
    assert.equal("Path" in call.env, false);
  }
  assert.deepEqual(environment, { Path: "original-path" });
  assert.match(calls[0].args[0], /build-desktop\.mjs$/);
  assert.match(calls[2].args[0], /desktop-release-manifest\.mjs$/);
});

test("missing WiX is prepared before packaging an already built CI runtime", () => {
  let ready = false;
  const commands: string[] = [];
  makeDesktop("fixture", { platform: "win32", skipBuild: true, exists: () => ready,
    run: (command, args) => {
      commands.push(args.at(-1)!);
      if (command === "powershell.exe") ready = true;
    },
  });
  assert.match(commands[0], /provision-wix\.ps1$/);
  assert.equal(commands.length, 3);
});

test("failed or incomplete WiX preparation prevents build and packaging", () => {
  for (const failure of [false, true]) {
    let calls = 0;
    assert.throws(() => makeDesktop("fixture", { platform: "win32", exists: () => false,
      run: () => { calls++; if (failure) throw new Error("download failed"); },
    }), failure ? /download failed/ : /did not produce/);
    assert.equal(calls, 1);
  }
});

test("a failed build or make never produces release evidence", () => {
  for (const failedStep of [1, 2]) {
    let calls = 0;
    assert.throws(() => makeDesktop("fixture", { platform: "win32", exists: () => true,
      run: () => { if (++calls === failedStep) throw new Error("step failed"); },
    }), /step failed/);
    assert.equal(calls, failedStep);
  }
});
