/**
 * @internal
 * @module stream
 *
 * Purpose: Observes and selectively rewrites JSON-RPC messages as they pass
 * through the proxy, without buffering the whole response. Both transports are
 * covered: `text/event-stream` (the normal MCP Streamable HTTP case, transformed
 * line by line) and plain `application/json` (single-shot responses).
 *
 * Consumers: `src/server.ts`.
 *
 * Why streaming matters: `you-research` at high effort can stream for minutes.
 * Buffering the body would delay the first byte past Apify's 5-minute Standby
 * first-response cap, so the transform must forward each chunk as it arrives.
 */

import type { JsonRpcId } from './proxy.ts'

/**
 * Callbacks invoked for every JSON-RPC response observed in a body.
 *
 * @property onResponse - Side-effect hook, called once per response message.
 *   Used to detect successful `tools/call` results for charging.
 * @property mapResult - Pure-ish mapping hook, called with the id and `result`
 *   of every response message. Must return the same reference when nothing
 *   changes, which is how the transform knows it can forward the original bytes.
 *
 * @public
 */
export type StreamEventHandlers = {
  onResponse: (response: Record<string, unknown>) => void
  mapResult: (id: JsonRpcId, result: unknown) => unknown
}

/**
 * Extracts the id from a parsed JSON-RPC message.
 *
 * @param message - Parsed JSON-RPC message
 * @returns The id when it is a string, number, or null; otherwise undefined
 *
 * @internal
 */
const readId = (message: Record<string, unknown>): JsonRpcId | undefined => {
  const id = message.id
  if (id === null || typeof id === 'string' || typeof id === 'number') return id
  return undefined
}

/**
 * Rewrites a single parsed JSON-RPC message, applying {@link StreamEventHandlers.mapResult}.
 *
 * @param message - Parsed JSON-RPC message, or any non-object value
 * @param handlers - Observation and mapping callbacks
 * @returns The original message when untouched, or a shallow copy with a mapped `result`
 *
 * @remarks
 * Notifications and requests (messages without a `result` key) are passed
 * through untouched and do not trigger `onResponse`, so streaming progress
 * notifications cost nothing.
 *
 * @internal
 */
const rewriteMessage = (message: unknown, handlers: StreamEventHandlers): unknown => {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) return message
  const record = message as Record<string, unknown>
  if (!('result' in record)) return message

  handlers.onResponse(record)
  const id = readId(record) ?? null
  const mapped = handlers.mapResult(id, record.result)
  if (mapped === record.result) return message
  return { ...record, result: mapped }
}

/**
 * Applies {@link StreamEventHandlers} to a complete JSON body.
 *
 * @param payload - Raw JSON text of a JSON-RPC message or batch
 * @param handlers - Observation and mapping callbacks
 * @returns The rewritten JSON text, or the original payload when parsing fails or nothing changed
 *
 * @remarks
 * Malformed payloads are returned verbatim rather than rejected: the proxy must
 * never turn a valid upstream response into an error just because its own
 * inspection could not parse it.
 *
 * @public
 */
export const inspectJsonRpcPayload = (payload: string, handlers: StreamEventHandlers): string => {
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return payload
  }

  if (Array.isArray(parsed)) {
    let changed = false
    const rewritten = parsed.map((message) => {
      const next = rewriteMessage(message, handlers)
      if (next !== message) changed = true
      return next
    })
    return changed ? JSON.stringify(rewritten) : payload
  }

  const rewritten = rewriteMessage(parsed, handlers)
  return rewritten === parsed ? payload : JSON.stringify(rewritten)
}

/**
 * Rewrites one SSE line, leaving non-data lines untouched.
 *
 * @param line - A single line without its trailing newline
 * @param handlers - Observation and mapping callbacks
 * @returns The (possibly rewritten) line
 *
 * @internal
 */
const rewriteSseLine = (line: string, handlers: StreamEventHandlers): string => {
  if (!line.startsWith('data:')) return line
  const payload = line.slice('data:'.length).trimStart()
  if (!payload) return line
  const inspected = inspectJsonRpcPayload(payload, handlers)
  return inspected === payload ? line : `data: ${inspected}`
}

/**
 * Builds a transform that inspects SSE chunks as they stream through.
 *
 * @param handlers - Observation and mapping callbacks
 * @returns A `TransformStream` suitable for `ReadableStream.pipeThrough`
 *
 * @remarks
 * Lines are reassembled across chunk boundaries with a text buffer, since a
 * single SSE `data:` line may be split across arbitrary byte boundaries. Multi
 * -byte characters split across chunks are handled by the streaming
 * `TextDecoder`. Partial trailing lines are flushed on stream end.
 *
 * @public
 */
export const inspectSseStream = (handlers: StreamEventHandlers): TransformStream<Uint8Array, Uint8Array> => {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buffer = ''

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true })

      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, '')
        buffer = buffer.slice(newlineIndex + 1)
        controller.enqueue(encoder.encode(`${rewriteSseLine(line, handlers)}\n`))
        newlineIndex = buffer.indexOf('\n')
      }
    },
    flush(controller) {
      buffer += decoder.decode()
      if (!buffer) return
      controller.enqueue(encoder.encode(rewriteSseLine(buffer.replace(/\r$/, ''), handlers)))
    },
  })
}
