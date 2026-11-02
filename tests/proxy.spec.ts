import { describe, expect, test } from 'bun:test'
import {
  BALANCE_TOOL_NAME,
  buildBalanceBlockedResponse,
  buildUpstreamErrorBody,
  buildUpstreamHeaders,
  buildUpstreamSearchParams,
  buildUpstreamUrl,
  CHARGE_EVENT_BY_TOOL,
  collectToolCalls,
  collectToolsListIds,
  filterToolsListResult,
  isPaymentAuthHeader,
  isSuccessfulToolResult,
  resolveChargeEvent,
  safeJsonParse,
} from '../src/proxy.ts'

const inbound = (headers: Record<string, string> = {}): Headers => new Headers(headers)

describe('isPaymentAuthHeader', () => {
  test('matches the Payment scheme case-insensitively', () => {
    expect(isPaymentAuthHeader('Payment abc')).toBe(true)
    expect(isPaymentAuthHeader('payment abc')).toBe(true)
    expect(isPaymentAuthHeader('PAYMENT abc')).toBe(true)
  })

  test('does not match Bearer or missing headers', () => {
    expect(isPaymentAuthHeader('Bearer abc')).toBe(false)
    expect(isPaymentAuthHeader(undefined)).toBe(false)
    expect(isPaymentAuthHeader(null)).toBe(false)
    expect(isPaymentAuthHeader('Payment')).toBe(false)
  })
})

describe('buildUpstreamHeaders', () => {
  const base = { userAgent: 'apify-actor:you-mcp/0.1.0' }

  test('prefers the caller BYOK key over the actor key', () => {
    const auth = buildUpstreamHeaders({
      ...base,
      inbound: inbound({ authorization: 'Bearer apify_token' }),
      byokKey: 'ydc-caller',
      actorApiKey: 'ydc-operator',
    })
    expect(auth.headers.authorization).toBe('Bearer ydc-caller')
    expect(auth.hasByok).toBe(true)
    expect(auth.keyless).toBe(false)
  })

  test('never forwards the Apify token as the upstream key', () => {
    const auth = buildUpstreamHeaders({
      ...base,
      inbound: inbound({ authorization: 'Bearer apify_token' }),
      byokKey: 'ydc-caller',
      actorApiKey: undefined,
    })
    expect(auth.headers.authorization).not.toContain('apify_token')
  })

  test('falls back to the actor key when no BYOK key is present', () => {
    const auth = buildUpstreamHeaders({
      ...base,
      inbound: inbound({ authorization: 'Bearer apify_token' }),
      byokKey: undefined,
      actorApiKey: 'ydc-operator',
    })
    expect(auth.headers.authorization).toBe('Bearer ydc-operator')
    expect(auth.hasByok).toBe(false)
    expect(auth.keyless).toBe(false)
  })

  test('sends no Authorization header when no key resolves (keyless profile)', () => {
    const auth = buildUpstreamHeaders({
      ...base,
      inbound: inbound({ authorization: 'Bearer apify_token' }),
      byokKey: undefined,
      actorApiKey: undefined,
    })
    expect(auth.headers.authorization).toBeUndefined()
    expect(auth.keyless).toBe(true)
    expect(auth.payment).toBe(false)
  })

  test('forwards a Payment authorization and does not add a Bearer token', () => {
    const auth = buildUpstreamHeaders({
      ...base,
      inbound: inbound({ authorization: 'Payment xyz' }),
      byokKey: undefined,
      actorApiKey: 'ydc-operator',
    })
    expect(auth.headers.authorization).toBe('Payment xyz')
    expect(auth.payment).toBe(true)
    expect(auth.keyless).toBe(false)
  })

  test('forwards payment retry headers', () => {
    const auth = buildUpstreamHeaders({
      ...base,
      inbound: inbound({ 'payment-signature': 'sig', 'x-payment': 'pay' }),
      byokKey: undefined,
      actorApiKey: undefined,
    })
    expect(auth.headers['payment-signature']).toBe('sig')
    expect(auth.headers['x-payment']).toBe('pay')
  })

  test('forwards MCP transport headers and sets the attribution user agent', () => {
    const auth = buildUpstreamHeaders({
      ...base,
      inbound: inbound({
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-session-id': 'sess-1',
        'mcp-protocol-version': '2025-06-18',
      }),
      byokKey: undefined,
      actorApiKey: undefined,
    })
    expect(auth.headers.accept).toBe('application/json, text/event-stream')
    expect(auth.headers['content-type']).toBe('application/json')
    expect(auth.headers['mcp-session-id']).toBe('sess-1')
    expect(auth.headers['mcp-protocol-version']).toBe('2025-06-18')
    expect(auth.headers['user-agent']).toBe(base.userAgent)
  })

  test('drops unknown inbound headers rather than passing them through', () => {
    const auth = buildUpstreamHeaders({
      ...base,
      inbound: inbound({ cookie: 'session=secret', 'x-apify-actor-id': 'abc' }),
      byokKey: undefined,
      actorApiKey: undefined,
    })
    expect(auth.headers.cookie).toBeUndefined()
    expect(auth.headers['x-apify-actor-id']).toBeUndefined()
  })
})

describe('buildUpstreamSearchParams', () => {
  test('drops the Apify token and keeps upstream parameters', () => {
    const params = buildUpstreamSearchParams(new URLSearchParams('token=apify_secret&profile=free&tools=you-search'))
    expect(params.get('token')).toBeNull()
    expect(params.get('profile')).toBe('free')
    expect(params.get('tools')).toBe('you-search')
  })
})

describe('buildUpstreamUrl', () => {
  const base = 'https://api.you.com/mcp'

  test('maps the bare MCP path', () => {
    expect(buildUpstreamUrl(base, '/mcp', new URLSearchParams())).toBe('https://api.you.com/mcp')
  })

  test('preserves single-tool path suffixes', () => {
    expect(buildUpstreamUrl(base, '/mcp/finance', new URLSearchParams())).toBe('https://api.you.com/mcp/finance')
    expect(buildUpstreamUrl(base, '/mcp/research', new URLSearchParams())).toBe('https://api.you.com/mcp/research')
  })

  test('appends forwarded query parameters', () => {
    expect(buildUpstreamUrl(base, '/mcp', new URLSearchParams('profile=free&token=secret'))).toBe(
      'https://api.you.com/mcp?profile=free',
    )
  })
})

describe('collectToolCalls', () => {
  test('collects tools/call entries with their ids', () => {
    const body = {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'you-search', arguments: { query: 'x' } },
    }
    expect(collectToolCalls(body)).toEqual([{ id: 7, toolName: 'you-search' }])
  })

  test('ignores other methods and non-object entries', () => {
    const batch = [
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'initialize', params: {} },
      null,
      'nonsense',
    ]
    expect(collectToolCalls(batch)).toEqual([])
  })

  test('handles a batch containing several tool calls', () => {
    const batch = [
      { jsonrpc: '2.0', id: 'a', method: 'tools/call', params: { name: 'you-search' } },
      { jsonrpc: '2.0', id: 'b', method: 'tools/call', params: { name: BALANCE_TOOL_NAME } },
    ]
    expect(collectToolCalls(batch)).toEqual([
      { id: 'a', toolName: 'you-search' },
      { id: 'b', toolName: BALANCE_TOOL_NAME },
    ])
  })

  test('tolerates a missing tool name', () => {
    expect(collectToolCalls({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} })).toEqual([
      { id: 1, toolName: '' },
    ])
  })
})

describe('collectToolsListIds', () => {
  test('collects stringified ids for tools/list requests', () => {
    expect(collectToolsListIds({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).toEqual(['3'])
    expect(
      collectToolsListIds([
        { jsonrpc: '2.0', id: 'x', method: 'tools/list' },
        { jsonrpc: '2.0', id: 'y', method: 'tools/call', params: { name: 'you-search' } },
      ]),
    ).toEqual(['x'])
  })
})

describe('filterToolsListResult', () => {
  const result = {
    tools: [{ name: 'you-search' }, { name: BALANCE_TOOL_NAME }, { name: 'you-research' }],
  }

  test('hides you-balance when the caller brought no key', () => {
    const filtered = filterToolsListResult(result, false) as typeof result
    expect(filtered.tools.map((tool) => tool.name)).toEqual(['you-search', 'you-research'])
  })

  test('keeps the original reference when nothing is filtered', () => {
    expect(filterToolsListResult(result, true)).toBe(result)
  })

  test('keeps the original reference when only allowed tools are present', () => {
    const onlyAllowed = { tools: [{ name: 'you-search' }] }
    expect(filterToolsListResult(onlyAllowed, false)).toBe(onlyAllowed)
  })

  test('ignores malformed results', () => {
    expect(filterToolsListResult(undefined, false)).toBeUndefined()
    expect(filterToolsListResult({ tools: 'nope' }, false)).toEqual({ tools: 'nope' })
  })
})

describe('buildBalanceBlockedResponse', () => {
  test('returns a tool-level error so MCP clients surface the message', () => {
    const response = buildBalanceBlockedResponse(42)
    expect(response.jsonrpc).toBe('2.0')
    expect(response.id).toBe(42)
    expect(response.error).toBeUndefined()
    const result = response.result as { isError: boolean; content: Array<{ text: string }> }
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('X-YDC-API-Key')
  })

  test('normalizes a null id to a null id', () => {
    expect(buildBalanceBlockedResponse(null).id).toBeNull()
  })
})

describe('isSuccessfulToolResult', () => {
  test('accepts a result without errors', () => {
    expect(isSuccessfulToolResult({ jsonrpc: '2.0', id: 1, result: { content: [] } })).toBe(true)
  })

  test('rejects protocol errors, tool-level isError, and malformed values', () => {
    expect(isSuccessfulToolResult({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'x' } })).toBe(false)
    expect(isSuccessfulToolResult({ jsonrpc: '2.0', id: 1, result: { isError: true } })).toBe(false)
    expect(isSuccessfulToolResult({ jsonrpc: '2.0', id: 1 })).toBe(false)
    expect(isSuccessfulToolResult(null)).toBe(false)
    expect(isSuccessfulToolResult('x')).toBe(false)
  })
})

describe('resolveChargeEvent', () => {
  const base = { toolName: 'you-search', hasByok: false, payment: false, profile: undefined, chargingEnabled: true }

  test('charges the mapped event for a metered tool when enabled', () => {
    expect(resolveChargeEvent(base)).toBe(CHARGE_EVENT_BY_TOOL['you-search'])
  })

  test('charges nothing when charging is disabled', () => {
    expect(resolveChargeEvent({ ...base, chargingEnabled: false })).toBeUndefined()
  })

  test('never charges BYOK or x402/MPP callers', () => {
    expect(resolveChargeEvent({ ...base, hasByok: true })).toBeUndefined()
    expect(resolveChargeEvent({ ...base, payment: true })).toBeUndefined()
  })

  test('never charges keyless profiles', () => {
    expect(resolveChargeEvent({ ...base, profile: 'free' })).toBeUndefined()
    expect(resolveChargeEvent({ ...base, profile: 'discover' })).toBeUndefined()
    expect(resolveChargeEvent({ ...base, profile: 'thoughtspot' })).toBe(CHARGE_EVENT_BY_TOOL['you-search'])
  })

  test('never charges unmetered or unknown tools', () => {
    expect(resolveChargeEvent({ ...base, toolName: BALANCE_TOOL_NAME })).toBeUndefined()
    expect(resolveChargeEvent({ ...base, toolName: 'you-unknown' })).toBeUndefined()
  })
})

describe('safeJsonParse', () => {
  test('parses valid JSON and tolerates junk', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 })
    expect(safeJsonParse('not json')).toBeUndefined()
    expect(safeJsonParse(undefined)).toBeUndefined()
    expect(safeJsonParse('')).toBeUndefined()
  })
})

describe('buildUpstreamErrorBody', () => {
  test('preserves the request id for a single request', () => {
    const body = buildUpstreamErrorBody({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, 'timed out')
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32603, message: 'Upstream MCP request failed: timed out' },
    })
  })

  test('returns one error per message for a batch', () => {
    const body = buildUpstreamErrorBody(
      [
        { jsonrpc: '2.0', id: 1, method: 'tools/list' },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'you-search' } },
      ],
      'boom',
    )
    expect(Array.isArray(body)).toBe(true)
    expect((body as Array<{ id: number }>).map((entry) => entry.id)).toEqual([1, 2])
  })
})
