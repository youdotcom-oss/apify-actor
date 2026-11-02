/**
 * @internal
 * @module config
 *
 * Purpose: Resolves every Actor tunable from environment variables so that
 * secrets stay out of `input_schema.json` and out of source control.
 *
 * Consumers: `src/main.ts` (builds the config once at boot), `src/server.ts`
 * (reads upstream URL, timeout, and user agent per request).
 *
 * Common modification scenarios:
 * - Adding a tunable: add the field to {@link ActorConfig}, read it in
 *   {@link readConfig} with a documented default, and cover it in
 *   `tests/config.spec.ts`.
 * - Pointing at staging: set `YDC_MCP_UPSTREAM_URL` in Apify Console or `.env`.
 */

/**
 * Environment bag the config reader accepts.
 *
 * @remarks Matches `process.env` shape but is injected so tests can supply a
 * literal object instead of mutating global state.
 *
 * @public
 */
export type Env = Record<string, string | undefined>

/**
 * Resolved, immutable Actor configuration.
 *
 * @property upstreamMcpUrl - Base URL of the upstream You.com MCP server,
 *   without a trailing slash. Per-request paths (`/mcp`, `/mcp/finance`,
 *   `/mcp/research`) are appended to it.
 * @property actorApiKey - Actor-owner `YDC_API_KEY` used as the fallback for
 *   callers that do not supply their own key, or `undefined` when unset.
 *   Never used for `you-balance` (see `src/proxy.ts`).
 * @property chargingEnabled - Whether pay-per-event charging is active.
 * @property firstByteTimeoutMs - Deadline for the upstream response *headers*.
 *   The body stream is not subject to it, because deep research responses can
 *   legitimately stream for minutes.
 * @property userAgent - `User-Agent` sent upstream, used by You.com to
 *   attribute traffic to this Actor.
 *
 * @public
 */
export type ActorConfig = {
  readonly upstreamMcpUrl: string
  readonly actorApiKey: string | undefined
  readonly chargingEnabled: boolean
  readonly firstByteTimeoutMs: number
  readonly userAgent: string
}

/** Default upstream MCP endpoint; override with `YDC_MCP_UPSTREAM_URL`. */
export const DEFAULT_UPSTREAM_MCP_URL = 'https://api.you.com/mcp'

/**
 * Default upstream first-byte deadline in milliseconds.
 *
 * @remarks Deliberately under Apify's 5-minute Standby first-response cap so a
 * stalled upstream produces a clean error instead of a platform timeout.
 */
export const DEFAULT_FIRST_BYTE_TIMEOUT_MS = 290_000

/** Version reported to the upstream server in the `User-Agent` header. */
export const ACTOR_VERSION = '0.1.0'

/** `User-Agent` value identifying traffic as coming from this Actor. */
export const DEFAULT_USER_AGENT = `apify-actor:you-com-mcp/${ACTOR_VERSION}`

/**
 * Reads a positive integer from an environment variable.
 *
 * @param raw - Raw environment value, possibly undefined or malformed
 * @param fallback - Value returned when `raw` is absent or not a positive finite number
 * @returns A positive finite integer, or `fallback`
 *
 * @internal
 */
const parsePositiveInt = (raw: string | undefined, fallback: number): number => {
  if (raw === undefined) return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

/**
 * Normalizes the upstream MCP URL.
 *
 * @param raw - Configured base URL, possibly with a trailing slash or blank
 * @returns The base URL without a trailing slash, or {@link DEFAULT_UPSTREAM_MCP_URL}
 *
 * @internal
 */
const normalizeUpstreamUrl = (raw: string | undefined): string => {
  const trimmed = raw?.trim()
  if (!trimmed) return DEFAULT_UPSTREAM_MCP_URL
  return trimmed.replace(/\/+$/, '')
}

/**
 * Resolves the Actor configuration from environment variables.
 *
 * @param env - Environment bag to read; defaults to `process.env`
 * @returns Frozen {@link ActorConfig}
 *
 * @remarks
 * Recognized variables:
 * - `YDC_MCP_UPSTREAM_URL` — upstream base URL (default {@link DEFAULT_UPSTREAM_MCP_URL})
 * - `YDC_API_KEY` — actor-level You.com key fallback (secret; set in Apify Console)
 * - `YDC_PPE_CHARGING_ENABLED` — `"true"` to enable pay-per-event charging
 * - `YDC_FIRST_BYTE_TIMEOUT_MS` — upstream first-byte deadline
 *
 * A blank `YDC_API_KEY` is treated as unset so an empty Console value cannot
 * produce a bare `Authorization: Bearer ` header.
 *
 * @public
 */
export const readConfig = (env: Env = process.env): ActorConfig => ({
  upstreamMcpUrl: normalizeUpstreamUrl(env.YDC_MCP_UPSTREAM_URL),
  actorApiKey: env.YDC_API_KEY?.trim() || undefined,
  chargingEnabled: env.YDC_PPE_CHARGING_ENABLED === 'true',
  firstByteTimeoutMs: parsePositiveInt(env.YDC_FIRST_BYTE_TIMEOUT_MS, DEFAULT_FIRST_BYTE_TIMEOUT_MS),
  userAgent: DEFAULT_USER_AGENT,
})
