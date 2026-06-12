// Child-environment sanitizer. This is the entire "use your subscription"
// mechanism (PROPOSAL §5.5, open-design #398): strip Anthropic credentials so
// the CLI's own `claude login` (Pro/Max OAuth) wins. If the user points at a
// custom base URL, their token is intentional — leave it.
//
// Replicates the #3 PoC recipe exactly (scripts/poc/translate-poc.mjs).

const ANTHROPIC_CREDENTIAL = /^anthropic_(api_key|auth_token)$/i;

// Vars that route Claude Code to AWS Bedrock / Google Vertex — i.e. per-token
// API billing — instead of the subscription the strip exists to protect (#25).
// The `CLAUDE_CODE_USE_*` flags are the activation switch; the region/base-url
// companions are stripped too as defense-in-depth.
const BILLING_REDIRECT =
  /^(?:CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX|ANTHROPIC_BEDROCK_BASE_URL|ANTHROPIC_VERTEX_BASE_URL|ANTHROPIC_VERTEX_PROJECT_ID|CLOUD_ML_REGION|AWS_REGION|AWS_DEFAULT_REGION|VERTEX_REGION_.+)$/i;

/**
 * Build the child env from a base environment.
 * - Drops undefined values (so the result is a clean string map).
 * - Pins `MAX_THINKING_TOKENS=0` (translation needs no thinking budget).
 * - Unless `ANTHROPIC_BASE_URL` is set (intentional custom endpoint), removes
 *   `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` AND the Bedrock/Vertex
 *   billing-redirect vars, so subscription auth wins.
 */
export function sanitizeChildEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value;
  }
  env.MAX_THINKING_TOKENS = "0";
  if (!env.ANTHROPIC_BASE_URL) {
    for (const key of Object.keys(env)) {
      if (ANTHROPIC_CREDENTIAL.test(key) || BILLING_REDIRECT.test(key)) delete env[key];
    }
  }
  return env;
}
