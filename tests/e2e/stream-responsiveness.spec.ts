import { expect, test } from "@playwright/test";
import { heavyHistory, longReport, measureStream } from "../helpers/stream-load";

// A streamed reply must cost the same in a long, tool-heavy conversation as in
// an empty one. Re-rendering every saved answer on each delta made the stream
// fall minutes behind and left the page unable to take input. Comparing the two
// runs on the same machine keeps the check independent of runner speed.
test("a long tool-heavy conversation streams as smoothly as an empty one", async ({ browser, baseURL }) => {
  test.setTimeout(240_000);
  const { storageState, locale } = test.info().project.use;
  const measure = async (history: ReturnType<typeof heavyHistory>) => {
    const context = await browser.newContext({ baseURL, storageState, locale });
    try {
      return await measureStream(await context.newPage(), history, { streamTools: 12 });
    } finally {
      await context.close();
    }
  };
  const empty = await measure(heavyHistory(0, 0));
  const heavy = await measure(heavyHistory(40, 5));
  const summary = JSON.stringify({ empty, heavy });
  test.info().annotations.push({ type: "stream-load", description: summary });
  expect(heavy.elapsed, summary).toBeLessThan(empty.elapsed * 1.5);
});

// Within one reply, a finished paragraph must not be parsed again on every
// delta. Otherwise each delta costs more the longer the reply gets, and a long
// report on a slower machine falls minutes behind its stream.
test("a long reply costs no more per delta than a short one", async ({ browser, baseURL }) => {
  test.setTimeout(300_000);
  const { storageState, locale } = test.info().project.use;
  const perDelta = async (sections: number) => {
    const context = await browser.newContext({ baseURL, storageState, locale });
    try {
      const answer = longReport(sections);
      const load = await measureStream(await context.newPage(), heavyHistory(0, 0), { streamTools: 0, cpu: 4, answer, deltaSize: 40 });
      return { ...load, perDelta: load.elapsed / Math.ceil(answer.length / 40) };
    } finally {
      await context.close();
    }
  };
  const short = await perDelta(10);
  const long = await perDelta(100);
  const summary = JSON.stringify({ short, long });
  test.info().annotations.push({ type: "stream-load", description: summary });
  expect(long.perDelta, summary).toBeLessThan(short.perDelta * 1.5);
});
