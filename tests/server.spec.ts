import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import type { Server } from 'bun'
import { readConfig } from '../src/config.ts'
import { type AppDeps, createApp } from '../src/server.ts'

/**
 * Stub upstream You.com MCP server. Records what the proxy sent so the tests can
 * assert on credential translation without touching the real API.
 */
type Upstream = {
  server: Server<undefined>
  requests: Array<{ url: string; headers: Headers; body: string }>
  respond: (body: string, init?: ResponseInit) => void
}

let upstream: Upstream

beforeAll(() => {
  const requests: Upstream['requests'] = []
  let current: { body: string; init?: ResponseInit } = { body: '{}' }

  const server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push({
        url: request.url,
        headers: request.headers,
        body: request.method === 'POST' ? await request.text() : '',
      })
      return new Response(current.body, {
        headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'stub-session' },
        ...current.init,
      })
    },
  })

  upstream = {
    server,
    requests,
    respond: (body, init) => {
      current = { body, init }
    },
  }
})

afterAll(() => {
  upstream.server.stop(true)
})

const sse = (payload: unknown): string => `event: message\ndata: ${JSON.stringify(payload)}\n\n`

const buildApp = (options: Partial<AppDeps> & { env?: Record<string, string | undefined> } = {}) => {
  const charges: Array<{ eventName: string; count: number }> = []
  const logs: Array<{ level: string; message: string }> = []
  const { env, ...rest } = options

  const app = createApp({
    config: readConfig({
      YDC_MCP_UPSTREAM_URL: `http://localhost:${upstream.server.port}/mcp`,
      ...env,
    }),
    charge: async (eventName, count) => {
      charges.push({ eventName, count })
      return { eventChargeLimitReached: false }
    },
    log: (level, message) => {
      logs.push({ level, message })
    },
    ...rest,
  })

  return { app, charges, logs }
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer apify_token', ...headers },
      body: JSON.stringify(body),
    }),
  )

const toolsListRequest = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }
const toolCallRequest = (name: string) => ({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name, arguments: {} },
})

const readBody = async (response: Response): Promise<string> => response.text()

const toolNamesFrom = (sseText: string): string[] => {
  const dataLine = sseText.split('\n').find((line) => line.startsWith('data:'))
  const parsed = JSON.parse((dataLine ?? '').slice('data:'.length)) as {
    result: { tools: Array<{ name: string }> }
  }
  return parsed.result.tools.map((tool) => tool.name)
}

describe('readiness probe', () => {
  test('answers 200 OK for the Apify probe header', async () => {
    const { app } = buildApp()
    const response = await app.fetch(
      new Request('http://localhost/', { headers: { 'x-apify-container-server-readiness-probe': 'true' } }),
    )
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('OK')
  })

  test('answers a JSON status for a plain visit', async () => {
    const { app } = buildApp()
    const response = await app.fetch(new Request('http://localhost/'))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'ok', actor: 'you-com-mcp' })
  })
})

describe('tools/list filtering', () => {
  test('hides you-balance from callers without a key', async () => {
    upstream.respond(
      sse({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'you-search' }, { name: 'you-balance' }] },
      }),
    )
    const { app } = buildApp({ env: { YDC_API_KEY: 'ydc-operator' } })
    const text = await readBody(await post(app, '/mcp', toolsListRequest))
    expect(toolNamesFrom(text)).toEqual(['you-search'])
  })

  test('keeps you-balance for callers that bring their own key', async () => {
    upstream.respond(
      sse({
        jsonrpc: '2.0',
        id: 1,
        result: { tools: [{ name: 'you-search' }, { name: 'you-balance' }] },
      }),
    )
    const { app } = buildApp()
    const text = await readBody(await post(app, '/mcp', toolsListRequest, { 'x-ydc-api-key': 'ydc-caller' }))
    expect(toolNamesFrom(text)).toEqual(['you-search', 'you-balance'])
  })
})

describe('you-balance carve-out', () => {
  test('rejects the call before reaching upstream when no BYOK key is present', async () => {
    const { app, logs } = buildApp({ env: { YDC_API_KEY: 'ydc-operator' } })
    const before = upstream.requests.length
    const response = await post(app, '/mcp', toolCallRequest('you-balance'))
    const body = (await response.json()) as { result: { isError: boolean; content: Array<{ text: string }> } }

    expect(response.status).toBe(200)
    expect(body.result.isError).toBe(true)
    expect(body.result.content[0]?.text).toContain('X-YDC-API-Key')
    expect(upstream.requests.length).toBe(before)
    expect(logs.some((entry) => entry.message.includes('you-balance'))).toBe(true)
  })

  test('forwards the call when the caller supplies a key, using that key', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { data: { attributes: { balance: 100 } } } }))
    const { app } = buildApp({ env: { YDC_API_KEY: 'ydc-operator' } })
    const response = await post(app, '/mcp', toolCallRequest('you-balance'), { 'x-ydc-api-key': 'ydc-caller' })

    expect(response.status).toBe(200)
    const last = upstream.requests.at(-1)
    expect(last?.headers.get('authorization')).toBe('Bearer ydc-caller')
  })
})

describe('credential translation', () => {
  test('uses the actor key when the caller brings none', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { content: [] } }))
    const { app } = buildApp({ env: { YDC_API_KEY: 'ydc-operator' } })
    await post(app, '/mcp', toolCallRequest('you-search'))
    expect(upstream.requests.at(-1)?.headers.get('authorization')).toBe('Bearer ydc-operator')
  })

  test('does not forward the Apify standby token or the token query parameter', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { content: [] } }))
    const { app } = buildApp({ env: { YDC_API_KEY: 'ydc-operator' } })
    await post(app, '/mcp?token=apify_secret&profile=free', toolCallRequest('you-search'))

    const last = upstream.requests.at(-1)
    expect(last?.url).not.toContain('token=')
    expect(last?.url).toContain('profile=free')
    expect(last?.headers.get('authorization')).not.toContain('apify_secret')
    expect(last?.headers.get('user-agent')).toContain('apify-actor:you-com-mcp')
  })

  test('preserves single-tool path suffixes', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { content: [] } }))
    const { app } = buildApp()
    await post(app, '/mcp/finance', toolCallRequest('you-finance'))
    expect(upstream.requests.at(-1)?.url).toContain('/mcp/finance')
  })

  test('mirrors the upstream session header back to the caller', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { content: [] } }))
    const { app } = buildApp()
    const response = await post(app, '/mcp', toolCallRequest('you-search'))
    expect(response.headers.get('mcp-session-id')).toBe('stub-session')
  })
})

describe('pay-per-event charging', () => {
  test('charges once for a successful metered call when enabled', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'ok' }] } }))
    const { app, charges } = buildApp({
      env: { YDC_API_KEY: 'ydc-operator', YDC_PPE_CHARGING_ENABLED: 'true' },
    })
    await readBody(await post(app, '/mcp', toolCallRequest('you-search')))
    expect(charges).toEqual([{ eventName: 'you-search-call', count: 1 }])
  })

  test('does not charge when charging is disabled', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { content: [] } }))
    const { app, charges } = buildApp({ env: { YDC_API_KEY: 'ydc-operator' } })
    await readBody(await post(app, '/mcp', toolCallRequest('you-search')))
    expect(charges).toHaveLength(0)
  })

  test('does not charge a failed tool call', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { isError: true, content: [] } }))
    const { app, charges } = buildApp({
      env: { YDC_API_KEY: 'ydc-operator', YDC_PPE_CHARGING_ENABLED: 'true' },
    })
    await readBody(await post(app, '/mcp', toolCallRequest('you-search')))
    expect(charges).toHaveLength(0)
  })

  test('does not charge BYOK callers, keyless profiles, or unmetered tools', async () => {
    upstream.respond(sse({ jsonrpc: '2.0', id: 2, result: { content: [] } }))
    const byok = buildApp({ env: { YDC_API_KEY: 'ydc-operator', YDC_PPE_CHARGING_ENABLED: 'true' } })
    await readBody(await post(byok.app, '/mcp', toolCallRequest('you-search'), { 'x-ydc-api-key': 'ydc-caller' }))
    expect(byok.charges).toHaveLength(0)

    const free = buildApp({ env: { YDC_API_KEY: 'ydc-operator', YDC_PPE_CHARGING_ENABLED: 'true' } })
    await readBody(await post(free.app, '/mcp?profile=free', toolCallRequest('you-search')))
    expect(free.charges).toHaveLength(0)

    const unmetered = buildApp({ env: { YDC_API_KEY: 'ydc-operator', YDC_PPE_CHARGING_ENABLED: 'true' } })
    await readBody(await post(unmetered.app, '/mcp', toolCallRequest('you-unknown')))
    expect(unmetered.charges).toHaveLength(0)
  })
})

describe('upstream failures', () => {
  test('returns a JSON-RPC error with the caller id preserved when upstream fails', async () => {
    const { app } = buildApp({ config: { ...readConfig({}), upstreamMcpUrl: 'http://localhost:1/mcp' } })
    const response = await post(app, '/mcp', toolsListRequest)
    expect(response.status).toBe(502)
    const body = (await response.json()) as { id: number; error: { code: number } }
    expect(body.id).toBe(1)
    expect(body.error.code).toBe(-32603)
  })
})
