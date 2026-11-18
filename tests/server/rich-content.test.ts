import assert from "node:assert/strict";
import { test } from "node:test";

const { hasMath, prepareMath } = await import("@/components/chat/rich-content");

test("formulas are found outside code only, in the notations models use", () => {
  for (const text of ["$E=mc^2$", "$$\\sum_i x_i$$", "\\(a^2+b^2\\)", "\\[\\int_0^1 x\\,dx\\]"]) assert.equal(hasMath(text), true, text);
  for (const text of ["`$x$` in code", "```\n$x$\n```", "no formula here", "a single $ sign"]) assert.equal(hasMath(text), false, text);
});

test("\\( \\) and \\[ \\] become dollar math, a displayed formula on lines of its own", () => {
  assert.equal(prepareMath("see \\(a^2\\) here"), "see $a^2$ here");
  assert.equal(prepareMath("\\[\\frac{1}{3}\\]"), "\n$$\n\\frac{1}{3}\n$$\n");
  assert.equal(prepareMath("`\\(not math\\)`"), "`\\(not math\\)`", "code is left alone");
});

test("a dollar sign before a number is a price unless what follows looks like a formula", () => {
  assert.equal(prepareMath("costs $5 and $10"), "costs \\$5 and \\$10");
  assert.equal(prepareMath("价格 $199，折后 $159"), "价格 \\$199，折后 \\$159");
  assert.equal(prepareMath("$5 and $10 and $x$"), "\\$5 and \\$10 and $x$", "each price on its own; the formula after them stays");
  assert.equal(prepareMath("$2x+1$ is linear"), "$2x+1$ is linear");
  assert.equal(prepareMath("$3^2 = 9$"), "$3^2 = 9$");
  assert.equal(prepareMath("already \\$5"), "already \\$5", "an escaped dollar is not escaped twice");
});
