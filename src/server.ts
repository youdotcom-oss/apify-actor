/**
 * @internal
 * @module server
 *
 * Purpose: The Actor's HTTP surface — readiness probe plus the MCP proxy
 * endpoints — assembled as a Hono app with injected dependencies so it can be
 * exercised in tests without Apify or the network.
 *
 * Consumers: `src/main.ts` (serves it), `tests/server.spec.ts`.
 *
 * Endpoint contract:
 * - `GET /` — Apify Standby readiness probe; always 200.
 * - `GET|POST|DELETE /mcp` — full MCP server, all tools the caller may use.
 * - `GET|POST|DELETE /mcp/finance` — `you-finance` only (upstream semantics).
 * - `GET|POST|DELETE /mcp/research` — `you-research` only (upstream semantics).
 */

import { type Context, Hono } from 'hono'
import type { ActorConfig } from './config.ts'
import {
  BALANCE_TOOL_NAME,
  BYOK_HEADER,
  buildBalanceBlockedResponse,
  buildUpstreamErrorBody,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  collectToolCalls,
  collectToolsListIds,
  filterToolsListResult,
  isSuccessfulToolResult,
  resolveChargeEvent,
  safeJsonParse,
} from './proxy.ts'
import { inspectJsonRpcPayload, inspectSseStream, type StreamEventHandlers } from './stream.ts'

/**
 * Outcome of a charging attempt relevant to the proxy.
 *
 * @property eventChargeLimitReached - True when the caller's spending budget for
 *   this event is exhausted, meaning no further work should be produced.
 *
 * @public
 */
export type ChargeOutcome = {
  readonly eventChargeLimitReached: boolean
}

/**
 * Charges the caller for a pay-per-event event.
 *
 * @public
 */
export type ChargeFn = (eventName: string, count: number) => Promise<ChargeOutcome>

/**
 * Structured logging sink, mapped onto the Apify logger by `src/main.ts`.
 *
 * @public
 */
export type LogFn = (
  level: 'debug' | 'info' | 'warning' | 'error',
  message: string,
  data?: Record<string, unknown>,
) => void

/**
 * Dependencies the HTTP layer needs, injected for testability.
 *
 * @public
 */
export type AppDeps = {
  readonly config: ActorConfig
  readonly charge: ChargeFn
  readonly log: LogFn
}

/**
 * Extracts a human-readable message from an unknown thrown value.
 *
 * @internal
 */
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Header Apify sends on the readiness probe.
 *
 * @internal
 */
const READINESS_PROBE_HEADER = 'x-apify-container-server-readiness-probe'

/**
 * Deadline for the upstream response *headers* only.
 *
 * @param timeoutMs - First-byte deadline in milliseconds
 * @returns A signal plus a `clear` function the caller must invoke once headers arrive
 *
 * @remarks
 * The timer is cleared as soon as headers land so a long streaming body (deep
 * research) is never aborted mid-stream; only a stalled upstream is cut off.
 *
 * @internal
 */
const createFirstByteSignal = (timeoutMs: number): { signal: AbortSignal; clear: () => void } => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  return { signal: controller.signal, clear: () => clearTimeout(timer) }
}

/**
 * Handles one proxied MCP request.
 *
 * @param c - Hono request context
 * @param deps - Injected configuration, charging, and logging
 * @returns Upstream response, streamed through the inspection transform
 *
 * @remarks
 * Order of operations:
 * 1. Read and parse the request body (small; request buffering is fine).
 * 2. Resolve credentials and classify the request (BYOK / payment / keyless).
 * 3. Reject `you-balance` calls that have no BYOK key, before any upstream call.
 * 4. Forward and stream the response, charging on successful `tools/call`.
 *
 * @internal
 */
const handleMcp = async (c: Context, deps: AppDeps): Promise<Response> => {
  const { config, log } = deps
  const inbound = c.req.raw
  const method = inbound.method.toUpperCase()
  const requestUrl = new URL(inbound.url)

  const bodyText = method === 'POST' ? await inbound.text() : undefined
  const parsedBody = safeJsonParse(bodyText)

  const byokKey = inbound.headers.get(BYOK_HEADER)?.trim() || undefined
  const auth = buildUpstreamHeaders({
    inbound: inbound.headers,
    byokKey,
    actorApiKey: config.actorApiKey,
    userAgent: config.userAgent,
  })

  const toolsListIds = new Set(collectToolsListIds(parsedBody))
  const toolCalls = collectToolCalls(parsedBody)

  const blockedCalls = toolCalls.filter((call) => call.toolName === BALANCE_TOOL_NAME && !auth.hasByok)
  if (blockedCalls.length > 0) {
    log('warning', 'Rejected you-balance call without a caller-supplied You.com API key', {
      callCount: blockedCalls.length,
    })
    const responses = blockedCalls.map((call) => buildBalanceBlockedResponse(call.id))
    return c.json(Array.isArray(parsedBody) ? responses : (responses[0] as Record<string, unknown>))
  }

  const profile = requestUrl.searchParams.get('profile') ?? undefined
  const upstreamUrl = buildUpstreamUrl(config.upstreamMcpUrl, c.req.path, requestUrl.searchParams)
  const { signal, clear } = createFirstByteSignal(config.firstByteTimeoutMs)

  let upstreamResponse: Response
  try {
    upstreamResponse = await fetch(upstreamUrl, {
      method,
      headers: auth.headers,
      body: bodyText,
      signal,
      redirect: 'manual',
    })
  } catch (error) {
    log('error', 'Upstream MCP request failed', { message: errorMessage(error), upstreamUrl })
    return c.json(buildUpstreamErrorBody(parsedBody, errorMessage(error)), 502)
  } finally {
    clear()
  }

  const chargedIds = new Set<string>()
  const pendingCalls = new Map<string, string>()
  for (const call of toolCalls) {
    if (call.id === null) continue
    pendingCalls.set(String(call.id), call.toolName)
  }

  const handlers: StreamEventHandlers = {
    onResponse: (response) => {
      const id = response.id
      if (id === null || id === undefined) return
      const key = String(id)
      const toolName = pendingCalls.get(key)
      if (toolName === undefined || chargedIds.has(key)) return
      if (!isSuccessfulToolResult(response)) return

      const eventName = resolveChargeEvent({
        toolName,
        hasByok: auth.hasByok,
        payment: auth.payment,
        profile,
        chargingEnabled: config.chargingEnabled,
      })
      if (eventName === undefined) return

      chargedIds.add(key)
      void deps
        .charge(eventName, 1)
        .then((outcome) => {
          if (!outcome.eventChargeLimitReached) return
          log('warning', 'Pay-per-event charge limit reached', { eventName, toolName })
        })
        .catch((error) => {
          log('error', 'Failed to charge for tool call', { eventName, toolName, message: errorMessage(error) })
        })
    },
    mapResult: (id, result) => {
      if (id === null || !toolsListIds.has(String(id))) return result
      return filterToolsListResult(result, auth.hasByok)
    },
  }

  const contentType = upstreamResponse.headers.get('content-type') ?? ''
  const isEventStream = contentType.includes('text/event-stream')

  const responseHeaders = new Headers()
  responseHeaders.set('content-type', contentType || (isEventStream ? 'text/event-stream' : 'application/json'))
  responseHeaders.set('cache-control', 'no-cache, no-transform')
  const sessionId = upstreamResponse.headers.get('mcp-session-id')
  if (sessionId) responseHeaders.set('mcp-session-id', sessionId)

  if (isEventStream) {
    if (!upstreamResponse.body) {
      return new Response(null, { status: upstreamResponse.status, headers: responseHeaders })
    }
    const body = upstreamResponse.body.pipeThrough(inspectSseStream(handlers))
    return new Response(body, { status: upstreamResponse.status, headers: responseHeaders })
  }

  const text = await upstreamResponse.text()
  return new Response(text ? inspectJsonRpcPayload(text, handlers) : text, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  })
}

/**
 * Builds the Actor's Hono application.
 *
 * @param deps - Injected configuration, charging, and logging
 * @returns Configured Hono app, ready to serve
 *
 * @remarks Uses `strict: false` so `/mcp/` and `/mcp` behave identically, which
 * matters because MCP clients differ in whether they append a trailing slash.
 *
 * @public
 */
export const createApp = (deps: AppDeps): Hono => {
  const app = new Hono({ strict: false })

  app.get('/', (c) => {
    if (c.req.header(READINESS_PROBE_HEADER) !== undefined) return c.text('OK')
    return c.json({ status: 'ok', actor: 'you-com-mcp', standby: true })
  })

  const proxy = (c: Context) => handleMcp(c, deps)

  app.all('/mcp', proxy)
  app.all('/mcp/finance', proxy)
  app.all('/mcp/research', proxy)

  return app
}
