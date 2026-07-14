// Shared billing-settings defaults. Imported by both the webview's first-run
// DEFAULT_SETTINGS (main.ts) and the host's start-config fallback path
// (host/start-config.ts) so the two can't drift: a product change to the default
// pool amount or reset day now lands in one place. Dependency-free so both
// tsconfigs (webview / host) resolve it.

/** Default Agent-SDK monthly pool in USD (PROPOSAL §6; Pro preset). */
export const DEFAULT_POOL_USD = 20;

/** Default billing reset day of month (1–28). */
export const DEFAULT_RESET_DAY = 1;
