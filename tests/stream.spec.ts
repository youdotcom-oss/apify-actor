import { describe, expect, test } from 'bun:test'
import { inspectJsonRpcPayload, inspectSseStream } from '../src/stream.ts'

const collect = (handlers: Parameters<typeof inspectJsonRpcPayload>[1]) => {
  const observed: Array<Record<string, unknown>> = []
  const mapped: Array<{ id: unknown; result: unknown }> = []
  return {
    observed,
    mapped,
    handlers: {
      onResponse: (response: Record<string, unknown>) => {
        observed.push(response)
        handlers.onResponse(response)
      },
      mapResult: (id: unknown, result: unknown) => {
        mapped.push({ id, result })
        return handlers.mapResult(id as never, result)
      },
    },
  }
}

const passthrough = { onResponse: () => {}, mapResult: (_id: unknown, result: unknown) => result }

describe('inspectJsonRpcPayload', () => {
  test('returns the original text untouched when nothing changes', () => {
    const payload = '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"you-search"}]}}'
    expect(inspectJsonRpcPayload(payload, passthrough)).toBe(payload)
  })

  test('rewrites a tools/list result when the mapper returns a new value', () => {
    const payload = '{"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"you-search"},{"name":"you-balance"}]}}'
    const out = inspectJsonRpcPayload(payload, {
      onResponse: () => {},
      mapResult: (_id, result) => {
        const tools = (result as { tools: Array<{ name: string }> }).tools
        return { tools: tools.filter((tool) => tool.name !== 'you-balance') }
      },
    })
    expect(JSON.parse(out)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { tools: [{ name: 'you-search' }] },
    })
  })

  test('reports every response and notifies no-op for notifications', () => {
    const tracker = collect(passthrough)
    inspectJsonRpcPayload(
      '[{"jsonrpc":"2.0","method":"notifications/progress","params":{}},{"jsonrpc":"2.0","id":2,"result":{}}]',
      tracker.handlers,
    )
    expect(tracker.observed).toHaveLength(1)
    expect(tracker.observed[0]?.id).toBe(2)
  })

  test('passes malformed payloads through verbatim instead of erroring', () => {
    expect(inspectJsonRpcPayload('{not json', passthrough)).toBe('{not json')
  })
})

const readAll = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
  const decoder = new TextDecoder()
  let text = ''
  for await (const chunk of stream) {
    text += decoder.decode(chunk, { stream: true })
  }
  return text + decoder.decode()
}

const toStream = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

describe('inspectSseStream', () => {
  test('rewrites data lines and preserves event framing', async () => {
    const input = 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[{"name":"you-balance"}]}}\n\n'
    const out = await readAll(
      toStream([input]).pipeThrough(
        inspectSseStream({
          onResponse: () => {},
          mapResult: () => ({ tools: [] }),
        }),
      ),
    )
    expect(out).toBe('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n')
  })

  test('reassembles a data line split across chunks', async () => {
    const full = 'data: {"jsonrpc":"2.0","id":1,"result":{"a":1}}\n\n'
    const midpoint = Math.floor(full.length / 2)
    const out = await readAll(
      toStream([full.slice(0, midpoint), full.slice(midpoint)]).pipeThrough(inspectSseStream(passthrough)),
    )
    expect(out).toBe(full)
  })

  test('observes streamed responses for charging', async () => {
    const observed: unknown[] = []
    const stream = toStream([
      'event: message\ndata: {"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"ok"}]}}\n\n',
    ]).pipeThrough(
      inspectSseStream({
        onResponse: (response) => observed.push(response.id),
        mapResult: (_id, result) => result,
      }),
    )
    await readAll(stream)
    expect(observed).toEqual([5])
  })

  test('flushes a trailing line with no newline', async () => {
    const out = await readAll(
      toStream(['data: {"jsonrpc":"2.0","id":1,"result":{}}']).pipeThrough(inspectSseStream(passthrough)),
    )
    expect(out).toBe('data: {"jsonrpc":"2.0","id":1,"result":{}}')
  })
})
