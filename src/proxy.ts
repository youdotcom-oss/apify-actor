/**
 * @internal
 * @module proxy
 *
 * Purpose: Pure translation logic between the Apify-facing request and the
 * upstream You.com MCP server. Everything here is side-effect free so it can be
 * unit tested without a server, network, or Apify runtime.
 *
 * Consumers: `src/server.ts`.
 *
 * Security invariants enforced here:
 * - The caller's Apify token never reaches You.com; it is replaced by a You.com
 *   API key (BYOK or the actor-level secret) or omitted entirely.
 * - `you-balance` is never served with the actor-level secret, because that
 *   endpoint returns the *key owner's* billing balance. Upstream refuses to fall
 *   back to a server key for it; the proxy adds the same guarantee one hop earlier.
 * - The Apify `?token=` Standby fallback never reaches You.com.
 */

/**
 * JSON-RPC message identifier.
 *
 * @public
 */
export type JsonRpcId = string | number | null

/**
 * Header a caller uses to bring their own You.com API key.
 *
 * @remarks `Authorization` cannot carry it: Apify Standby consumes that header
 * for its own `Bearer <APIFY_TOKEN>` authentication, and MCP clients set it
 * themselves.
 *
 * @public
 */
export const BYOK_HEADER = 'x-ydc-api-key'

/** Tool whose responses expose the key owner's billing balance. */
export const BALANCE_TOOL_NAME = 'you-balance'

/**
 * Error text returned when `you-balance` is called without a BYOK key.
 *
 * @public
 */
export const BALANCE_REQUIRES_KEY_MESSAGE =
  'you-balance requires a You.com API key supplied by the caller. Send it in the X-YDC-API-Key header. It is not served with the Actor operator key because that would disclose the operator account balance.'

/**
 * Caller-supplied request headers forwarded upstream.
 *
 * @remarks Allowlist rather than passthrough, so an inbound `Authorization`
 * (Apify token) or an Apify-internal header can never leak to You.com.
 *
 * `mcp-method` and `mcp-name` are REQUIRED for compliance by the Streamable
 * HTTP transport in MCP revision 2026-07-28 and later: the body names a method
 * and, for `tools/call` / `resources/read` / `prompts/get`, a name, and the
 * server rejects the request with `-32020` and HTTP 400 when the mirroring
 * headers are absent. Dropping them silently breaks every modern client, so
 * they must be forwarded even though this proxy never reads them itself.
 *
 * @see https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http
 *
 * @internal
 */
const FORWARDED_HEADERS = [
  'accept',
  'content-type',
  'mcp-session-id',
  'mcp-protocol-version',
  'mcp-method',
  'mcp-name',
  'last-event-id',
  'accept-language',
] as const

/**
 * x402 / Machine Payments Protocol headers forwarded unchanged.
 *
 * @internal
 */
const PAYMENT_HEADERS = ['payment-signature', 'x-payment'] as const

/**
 * Profiles that are keyless upstream and therefore never charged.
 *
 * @internal
 */
const KEYLESS_PROFILES: ReadonlySet<string> = new Set(['free', 'discover'])

/**
 * Maps a tool name to the pay-per-event event name charged for a successful call.
 *
 * @remarks Event names must match the events configured for the Actor in Apify
 * Console. `you-balance` is intentionally absent: it is BYOK-only and unmetered.
 *
 * @public
 */
export const CHARGE_EVENT_BY_TOOL: Readonly<Record<string, string>> = {
  'you-search': 'you-search-call',
  'you-contents': 'you-contents-call',
  'you-research': 'you-research-call',
  'you-finance': 'you-finance-call',
  'you-discover': 'you-discover-call',
}

/**
 * A pending `tools/call` extracted from an inbound request body.
 *
 * @property id - JSON-RPC id the upstream response will echo
 * @property toolName - Requested tool name, or an empty string when unparseable
 *
 * @public
 */
export type PendingToolCall = {
  readonly id: JsonRpcId
  readonly toolName: string
}

/**
 * Result of translating inbound credentials into upstream headers.
 *
 * @property headers - Headers to send upstream
 * @property hasByok - Whether the caller supplied their own You.com key
 * @property payment - Whether the request carries an x402/MPP payment authorization
 * @property keyless - Whether no You.com key was attached at all
 *
 * @public
 */
export type UpstreamAuth = {
  readonly headers: Record<string, string>
  readonly hasByok: boolean
  readonly payment: boolean
  readonly keyless: boolean
}

/**
 * Detects an `Authorization: Payment ...` header.
 *
 * @param authorization - Raw `Authorization` header value
 * @returns True when the header uses the Payment scheme (x402/MPP)
 *
 * @remarks Per RFC 7235 §2.1 the auth scheme is case-insensitive.
 *
 * @public
 */
export const isPaymentAuthHeader = (authorization: string | null | undefined): authorization is string =>
  authorization?.toLowerCase().startsWith('payment ') ?? false

/**
 * Parses a request body as JSON, tolerating malformed input.
 *
 * @param body - Raw request body text
 * @returns The parsed value, or undefined when blank or not valid JSON
 *
 * @public
 */
export const safeJsonParse = (body: string | undefined): unknown => {
  if (!body) return undefined
  try {
    return JSON.parse(body)
  } catch {
    return undefined
  }
}

/**
 * Reads the JSON-RPC `method` from a message.
 *
 * @internal
 */
const readMethod = (value: unknown): string | undefined => {
  if (value === null || typeof value !== 'object') return undefined
  const method = (value as Record<string, unknown>).method
  return typeof method === 'string' ? method : undefined
}

/**
 * Reads the id from a JSON-RPC message.
 *
 * @internal
 */
const readId = (value: unknown): JsonRpcId => {
  if (value === null || typeof value !== 'object') return null
  const id = (value as Record<string, unknown>).id
  if (typeof id === 'string' || typeof id === 'number') return id
  return null
}

/**
 * Normalizes a JSON-RPC body into an array of messages.
 *
 * @internal
 */
const asMessages = (body: unknown): unknown[] => (Array.isArray(body) ? body : [body])

/**
 * Extracts every `tools/call` in a request body.
 *
 * @param body - Parsed JSON-RPC request or batch
 * @returns One entry per `tools/call`, in body order
 *
 * @remarks Used to correlate later responses with the requested tool so that
 * charging and the balance carve-out do not depend on response contents.
 *
 * @public
 */
export const collectToolCalls = (body: unknown): PendingToolCall[] => {
  const calls: PendingToolCall[] = []
  for (const message of asMessages(body)) {
    if (readMethod(message) !== 'tools/call') continue
    const params = (message as Record<string, unknown>).params
    const name = params !== null && typeof params === 'object' ? (params as Record<string, unknown>).name : undefined
    calls.push({ id: readId(message), toolName: typeof name === 'string' ? name : '' })
  }
  return calls
}

/**
 * Extracts the ids of every `tools/list` request in a request body.
 *
 * @param body - Parsed JSON-RPC request or batch
 * @returns Ids of `tools/list` requests, stringified for set membership
 *
 * @public
 */
export const collectToolsListIds = (body: unknown): string[] => {
  const ids: string[] = []
  for (const message of asMessages(body)) {
    if (readMethod(message) !== 'tools/list') continue
    ids.push(String(readId(message)))
  }
  return ids
}

/**
 * Removes the `you-balance` entry from a `tools/list` result unless the caller
 * supplied their own key.
 *
 * @param result - The `result` value of a `tools/list` response
 * @param hasByok - Whether the caller supplied an `X-YDC-API-Key`
 * @returns The original result when nothing was removed, else a copy with filtered tools
 *
 * @public
 */
export const filterToolsListResult = (result: unknown, hasByok: boolean): unknown => {
  if (hasByok) return result
  if (result === null || typeof result !== 'object') return result

  const tools = (result as Record<string, unknown>).tools
  if (!Array.isArray(tools)) return result

  const filtered = tools.filter((tool) => {
    if (tool === null || typeof tool !== 'object') return true
    return (tool as Record<string, unknown>).name !== BALANCE_TOOL_NAME
  })

  if (filtered.length === tools.length) return result
  return { ...(result as Record<string, unknown>), tools: filtered }
}

/**
 * Builds the JSON-RPC error response returned when `you-balance` is called
 * without a BYOK key.
 *
 * @param id - Id of the offending request
 * @returns A JSON-RPC response carrying a tool-level error result
 *
 * @remarks Returns a `result` with `isError: true` rather than a protocol-level
 * `error`, so MCP clients surface the message to the model instead of treating
 * the call as a transport failure.
 *
 * @public
 */
export const buildBalanceBlockedResponse = (id: JsonRpcId): Record<string, unknown> => ({
  jsonrpc: '2.0',
  id: id ?? null,
  result: {
    content: [{ type: 'text', text: `Error: ${BALANCE_REQUIRES_KEY_MESSAGE}` }],
    isError: true,
  },
})

/**
 * Determines whether a JSON-RPC response represents a successful tool call.
 *
 * @param response - Parsed JSON-RPC response message
 * @returns True when there is no protocol error and no tool-level `isError`
 *
 * @public
 */
export const isSuccessfulToolResult = (response: unknown): boolean => {
  if (response === null || typeof response !== 'object') return false
  const record = response as Record<string, unknown>
  if (record.error !== undefined) return false
  const result = record.result
  if (result === null || typeof result !== 'object') return false
  return (result as Record<string, unknown>).isError !== true
}

/**
 * Decides which pay-per-event event, if any, a successful tool call should charge.
 *
 * @param options.toolName - Name of the tool that was called
 * @param options.hasByok - Whether the caller supplied their own You.com key
 * @param options.payment - Whether the request carried an x402/MPP authorization
 * @param options.profile - Value of the `profile` query parameter, if any
 * @param options.chargingEnabled - Whether charging is enabled for this deployment
 * @returns The event name to charge, or undefined when the call is not chargeable
 *
 * @remarks
 * Callers who already pay You.com directly (BYOK or x402/MPP) are never charged,
 * and neither are keyless profiles. Failures are filtered out by the caller via
 * {@link isSuccessfulToolResult} before this runs.
 *
 * @public
 */
export const resolveChargeEvent = (options: {
  toolName: string
  hasByok: boolean
  payment: boolean
  profile: string | undefined
  chargingEnabled: boolean
}): string | undefined => {
  const { toolName, hasByok, payment, profile, chargingEnabled } = options
  if (!chargingEnabled) return undefined
  if (hasByok || payment) return undefined
  if (profile !== undefined && KEYLESS_PROFILES.has(profile)) return undefined
  return CHARGE_EVENT_BY_TOOL[toolName]
}

/**
 * Translates inbound credentials into upstream request headers.
 *
 * @param options.inbound - Inbound request headers
 * @param options.byokKey - Caller-supplied You.com key from {@link BYOK_HEADER}, if any
 * @param options.actorApiKey - Actor-owner fallback key, if configured
 * @param options.userAgent - `User-Agent` to send upstream
 * @returns Upstream headers plus the resolved auth classification
 *
 * @remarks
 * Resolution order for `Authorization`:
 * 1. An inbound `Authorization: Payment ...` value is forwarded unchanged (x402/MPP).
 * 2. Otherwise a `Bearer` token is set from the BYOK key, falling back to the
 *    actor key. A caller-supplied key always wins over the operator's.
 * 3. With neither, no `Authorization` header is sent (keyless free/discover profiles).
 *
 * @public
 */
export const buildUpstreamHeaders = (options: {
  inbound: Headers
  byokKey: string | undefined
  actorApiKey: string | undefined
  userAgent: string
}): UpstreamAuth => {
  const { inbound, byokKey, actorApiKey, userAgent } = options
  const headers: Record<string, string> = {}

  for (const name of FORWARDED_HEADERS) {
    const value = inbound.get(name)
    if (value) headers[name] = value
  }
  for (const name of PAYMENT_HEADERS) {
    const value = inbound.get(name)
    if (value) headers[name] = value
  }

  const authorization = inbound.get('authorization')
  const payment = isPaymentAuthHeader(authorization)
  if (payment && authorization) headers.authorization = authorization

  const hasByok = Boolean(byokKey)
  const resolvedKey = byokKey ?? actorApiKey
  if (!payment && resolvedKey) headers.authorization = `Bearer ${resolvedKey}`

  headers['user-agent'] = userAgent

  return { headers, hasByok, payment, keyless: !payment && !resolvedKey }
}

/**
 * Builds the upstream query string, dropping Apify-specific parameters.
 *
 * @param searchParams - Inbound query parameters
 * @returns Query parameters safe to forward
 *
 * @remarks
 * `token` is the Apify Standby authentication fallback and must never reach
 * You.com. `profile` and `tools` pass through unchanged, along with any future
 * upstream parameter, so the proxy stays a transparent passthrough.
 *
 * @public
 */
export const buildUpstreamSearchParams = (searchParams: URLSearchParams): URLSearchParams => {
  const forwarded = new URLSearchParams()
  for (const [key, value] of searchParams) {
    if (key === 'token') continue
    forwarded.append(key, value)
  }
  return forwarded
}

/**
 * Builds the absolute upstream URL for an inbound MCP request.
 *
 * @param baseUrl - Configured upstream base URL (no trailing slash)
 * @param inboundPath - Inbound request path, e.g. `/mcp` or `/mcp/finance`
 * @param searchParams - Inbound query parameters
 * @returns Absolute upstream URL string
 *
 * @remarks The path suffix after `/mcp` is preserved so `/mcp/finance` and
 * `/mcp/research` keep their single-tool upstream semantics.
 *
 * @public
 */
export const buildUpstreamUrl = (baseUrl: string, inboundPath: string, searchParams: URLSearchParams): string => {
  const suffix = inboundPath.replace(/^\/mcp/, '')
  const query = buildUpstreamSearchParams(searchParams).toString()
  return `${baseUrl}${suffix}${query ? `?${query}` : ''}`
}

/**
 * Builds a JSON-RPC error body for a failed upstream request.
 *
 * @param body - Original parsed request body, used to recover the id
 * @param message - Error detail to surface to the caller
 * @returns A JSON-RPC error response, or a batch of them
 *
 * @public
 */
export const buildUpstreamErrorBody = (
  body: unknown,
  detail: string,
): Record<string, unknown> | Record<string, unknown>[] => {
  const responses = asMessages(body).map((message) => ({
    jsonrpc: '2.0',
    id: readId(message),
    error: { code: -32603, message: `Upstream MCP request failed: ${detail}` },
  }))
  return Array.isArray(body) ? responses : (responses[0] as Record<string, unknown>)
}
