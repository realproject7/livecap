// Child-environment sanitizer. This is the entire "use your subscription"
// mechanism (PROPOSAL §5.5, open-design #398): strip Anthropic credentials so
// the CLI's own `claude login` (Pro/Max OAuth) wins. If the user points at a
// custom base URL, their token is intentional — leave it.
//
// Replicates the #3 PoC recipe exactly (scripts/poc/translate-poc.mjs).

const ANTHROPIC_CREDENTIAL = /^anthropic_(api_key|auth_token|custom_headers)$/i;

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
 *   `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_CUSTOM_HEADERS`
 *   AND the Bedrock/Vertex billing-redirect vars, so subscription auth wins.
 *   `ANTHROPIC_CUSTOM_HEADERS` can smuggle `Authorization`/`x-api-key` → silent
 *   per-token API billing (the #25 class), so it strips with the credentials
 *   under the same intentional-custom-endpoint exception (#145).
 */
/** Copy an env map, dropping keys whose value is `undefined`, so `spawn` gets a
 *  clean string→string env. The shared primitive under both the Claude-specific
 *  {@link sanitizeChildEnv} and the local engine's plain drop-undefined pass. */
export function dropUndefinedEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

export function sanitizeChildEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env = dropUndefinedEnv(base);
  env.MAX_THINKING_TOKENS = "0";
  if (!env.ANTHROPIC_BASE_URL) {
    for (const key of Object.keys(env)) {
      if (ANTHROPIC_CREDENTIAL.test(key) || BILLING_REDIRECT.test(key)) delete env[key];
    }
  }
  return env;
}

// Outbound-proxy env vars, most-relevant-first for the HTTPS request that
// carries the transcript: `HTTPS_PROXY`/`ALL_PROXY` take effect over `HTTP_PROXY`.
// Both the conventional upper- and lower-case spellings are honored (#145).
const PROXY_VARS = ["HTTPS_PROXY", "ALL_PROXY", "HTTP_PROXY"] as const;

/**
 * Detect an active outbound proxy in the base environment (#145). Proxies are
 * NOT stripped — a user may legitimately need one — but the transcript must
 * never be routed through one *silently*, so the host surfaces a content-free
 * notice when this returns non-null.
 *
 * Returns a SAFE host label (`host` or `host:port`) for the highest-precedence
 * proxy var set, or null if none. The full value is never returned or logged:
 * it can embed credentials (`http://user:pass@host`) and is deliberately
 * reduced to host[:port] here.
 */
export function detectProxy(base: Record<string, string | undefined>): string | null {
  for (const name of PROXY_VARS) {
    for (const key of [name, name.toLowerCase()]) {
      const value = base[key];
      if (typeof value === "string" && value.trim() !== "") return safeHost(value.trim());
    }
  }
  return null;
}

/**
 * Detect an intentional custom Anthropic endpoint (`ANTHROPIC_BASE_URL`) in the
 * base environment (#174, sibling of the #145 proxy notice). Like a proxy, it is
 * NOT stripped — [`sanitizeChildEnv`] deliberately preserves it and its
 * credentials as a user's explicit choice — but it silently reroutes ALL Claude
 * CLI transcript traffic to an arbitrary host, so the transcript must never
 * transit it *silently*: the host surfaces a content-free notice when this
 * returns non-null.
 *
 * Returns a SAFE host label (`host` or `host:port`), or null when unset/blank.
 * The full URL is never returned or logged — it can embed credentials and a
 * path/query — and is reduced to host[:port] via the shared [`safeHost`].
 */
export function detectCustomEndpoint(base: Record<string, string | undefined>): string | null {
  const value = base.ANTHROPIC_BASE_URL;
  if (typeof value === "string" && value.trim() !== "") return safeHost(value.trim());
  return null;
}

/** Reduce a proxy / endpoint URL to `host[:port]`, dropping any embedded
 *  credentials and path/query. Shared by [`detectProxy`] and
 *  [`detectCustomEndpoint`] so both notices redact identically. */
function safeHost(raw: string): string {
  try {
    const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
    return url.port ? `${url.hostname}:${url.port}` : url.hostname;
  } catch {
    // Unparseable value: acknowledge the reroute is set without echoing the raw string.
    return "(set)";
  }
}
