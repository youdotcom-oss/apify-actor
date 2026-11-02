import { describe, expect, test } from 'bun:test'
import {
  ACTOR_VERSION,
  DEFAULT_FIRST_BYTE_TIMEOUT_MS,
  DEFAULT_UPSTREAM_MCP_URL,
  DEFAULT_USER_AGENT,
  readConfig,
} from '../src/config.ts'

describe('readConfig', () => {
  test('falls back to documented defaults on an empty environment', () => {
    const config = readConfig({})
    expect(config.upstreamMcpUrl).toBe(DEFAULT_UPSTREAM_MCP_URL)
    expect(config.actorApiKey).toBeUndefined()
    expect(config.chargingEnabled).toBe(false)
    expect(config.firstByteTimeoutMs).toBe(DEFAULT_FIRST_BYTE_TIMEOUT_MS)
    expect(config.userAgent).toBe(DEFAULT_USER_AGENT)
    expect(config.userAgent).toContain(ACTOR_VERSION)
  })

  test('strips trailing slashes from the upstream URL', () => {
    expect(readConfig({ YDC_MCP_UPSTREAM_URL: 'https://staging.you.com/mcp///' }).upstreamMcpUrl).toBe(
      'https://staging.you.com/mcp',
    )
  })

  test('treats a blank upstream URL as unset', () => {
    expect(readConfig({ YDC_MCP_UPSTREAM_URL: '   ' }).upstreamMcpUrl).toBe(DEFAULT_UPSTREAM_MCP_URL)
  })

  test('treats a blank API key as unset so no empty Bearer header is built', () => {
    expect(readConfig({ YDC_API_KEY: '' }).actorApiKey).toBeUndefined()
    expect(readConfig({ YDC_API_KEY: '   ' }).actorApiKey).toBeUndefined()
  })

  test('trims a configured API key', () => {
    expect(readConfig({ YDC_API_KEY: ' ydc-sk-abc \n' }).actorApiKey).toBe('ydc-sk-abc')
  })

  test('enables charging only for the exact string "true"', () => {
    expect(readConfig({ YDC_PPE_CHARGING_ENABLED: 'true' }).chargingEnabled).toBe(true)
    expect(readConfig({ YDC_PPE_CHARGING_ENABLED: 'TRUE' }).chargingEnabled).toBe(false)
    expect(readConfig({ YDC_PPE_CHARGING_ENABLED: '1' }).chargingEnabled).toBe(false)
  })

  test('ignores a non-numeric or non-positive first-byte timeout', () => {
    expect(readConfig({ YDC_FIRST_BYTE_TIMEOUT_MS: 'nope' }).firstByteTimeoutMs).toBe(DEFAULT_FIRST_BYTE_TIMEOUT_MS)
    expect(readConfig({ YDC_FIRST_BYTE_TIMEOUT_MS: '0' }).firstByteTimeoutMs).toBe(DEFAULT_FIRST_BYTE_TIMEOUT_MS)
    expect(readConfig({ YDC_FIRST_BYTE_TIMEOUT_MS: '-5' }).firstByteTimeoutMs).toBe(DEFAULT_FIRST_BYTE_TIMEOUT_MS)
    expect(readConfig({ YDC_FIRST_BYTE_TIMEOUT_MS: '1500.9' }).firstByteTimeoutMs).toBe(1500)
  })
})
