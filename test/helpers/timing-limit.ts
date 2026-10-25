/**
 * How the timing tests (NFR6, NFR7) judge a measured span. These functions are pure: they read
 * neither the real clock nor process.env, so their own tests need no real time.
 */

/** The limit that docs/requirements.md gives for NFR6 and NFR7. */
export const DOCUMENTED_LIMIT_MS = 10_000;

/** CI runners can be slow and busy, so the limit there is this many times the documented one. */
export const CI_LIMIT_FACTOR = 2;

/**
 * Time for the start of a timing test, before its first measured wait: startServe waits up to
 * the 5 second default of waitFor for the "Listening on" line. startAnswer returns at once.
 */
export const STARTUP_MARGIN_MS = 5_000;

/** The polling interval the timing tests give `imbehind answer`, so its polling wait is small. */
export const FAST_POLL_MS = 10;

/** The limit for one measured span: the documented one, or twice that on CI. */
export function timingLimitMs(env: Readonly<Record<string, string | undefined>>): number {
  return env.CI === "true" ? DOCUMENTED_LIMIT_MS * CI_LIMIT_FACTOR : DOCUMENTED_LIMIT_MS;
}

/**
 * The span to compare with the limit. A span measured without the polling wait gets one full
 * polling interval added, the longest the real polling could have made it wait. A span measured
 * with the polling wait already holds it, so it is used as it is.
 */
export function checkedSpanMs(span: {
  elapsedMs: number;
  pollingExcluded: boolean;
  pollIntervalMs: number;
}): number {
  return span.pollingExcluded ? span.elapsedMs + span.pollIntervalMs : span.elapsedMs;
}

/**
 * The timeout of a timing test: each of its sequential waits may take the whole limit, and the
 * start of the test may take the startup margin.
 */
export function timingTestTimeoutMs(test: {
  sequentialWaits: number;
  limitMs: number;
  startupMarginMs: number;
}): number {
  return test.sequentialWaits * test.limitMs + test.startupMarginMs;
}
