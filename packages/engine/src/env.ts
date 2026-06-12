// Child-environment sanitizer. This is the entire "use your subscription"
// mechanism (PROPOSAL §5.5, open-design #398): strip Anthropic credentials so
// the CLI's own `claude login` (Pro/Max OAuth) wins. If the user points at a
// custom base URL, their token is intentional — leave it.
//
// Replicates the #3 PoC recipe exactly (scripts/poc/translate-poc.mjs).

const ANTHROPIC_CREDENTIAL = /^anthropic_(api_key|auth_token)$/i;

/**
 * Build the child env from a base environment.
 * - Drops undefined values (so the result is a clean string map).
 * - Pins `MAX_THINKING_TOKENS=0` (translation needs no thinking budget).
 * - Removes `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` unless
 *   `ANTHROPIC_BASE_URL` is set.
 */
export function sanitizeChildEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value;
  }
  env.MAX_THINKING_TOKENS = "0";
  if (!env.ANTHROPIC_BASE_URL) {
    for (const key of Object.keys(env)) {
      if (ANTHROPIC_CREDENTIAL.test(key)) delete env[key];
    }
  }
  return env;
}
