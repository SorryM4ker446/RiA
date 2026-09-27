"use client";

import { useState } from "react";

/**
 * Whether a list may still show its first-paint loading state.
 *
 * Gating that on "there is nothing to show yet" looks right and is not. An
 * empty list is a legitimate steady state, so emptiness cannot tell a first
 * paint from a refresh of an empty list — every refresh would flash the
 * skeleton again and then collapse to the shorter empty state, which reads as a
 * jump. The skeleton is also a different height from what replaces it, so the
 * surrounding layout moves even when the content is meant to be unchanged.
 *
 * So the question is not "is the list empty" but "has this mount ever finished
 * a load". Pass the query that produced the rows and it resets when the query
 * genuinely changes, which is the one case where replacing content is correct.
 *
 * @param loading Whether a request is in flight.
 * @param queryKey Identity of the query the rows belong to.
 * @returns True only while the very first load for this query is in flight.
 */
export function useAwaitingFirstLoad(loading: boolean, queryKey: string): boolean {
  // The last render is kept as state rather than a ref so the answer can be
  // settled during render. Reading a ref here is flagged, and updating one from
  // an effect would mean setting state in an effect; adjusting during render
  // re-runs the component immediately, so what gets committed already reflects
  // the new value rather than the previous one.
  const [previous, setPrevious] = useState({ loading, queryKey, settled: false });
  if (previous.loading !== loading || previous.queryKey !== queryKey) {
    setPrevious({
      loading,
      queryKey,
      // A new query starts a new first paint; an idle request settles this one.
      settled: previous.queryKey !== queryKey ? false : !loading || previous.settled,
    });
  }
  return loading && !previous.settled;
}
