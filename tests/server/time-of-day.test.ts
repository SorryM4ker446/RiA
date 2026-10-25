import assert from "node:assert/strict";
import { test } from "node:test";
import { isTimeOfDay, parseTimeOfDay } from "../../src/lib/time-of-day";

test("typed times are read as 24-hour times, and anything that is not a time is refused", () => {
  for (const [typed, time] of [["9", "09:00"], ["09", "09:00"], ["930", "09:30"], ["0930", "09:30"], ["9:5", "09:05"], ["21:30", "21:30"], [" 2359 ", "23:59"], ["0", "00:00"]]) {
    assert.equal(parseTimeOfDay(typed), time, typed);
  }
  for (const typed of ["", "24", "2400", "12:60", "9:30pm", "上午9点", "12345", "1:2:3", "-1"]) assert.equal(parseTimeOfDay(typed), null, typed);
  assert.equal(isTimeOfDay("09:30"), true);
  for (const partial of ["9:30", "09:3", "0930", "24:00"]) assert.equal(isTimeOfDay(partial), false, partial);
});
