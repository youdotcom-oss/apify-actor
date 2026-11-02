/**
 * @internal
 * @module main
 *
 * Purpose: Actor entrypoint. Initializes the Apify SDK, decides whether this
 * run should serve traffic, and starts the HTTP server on the SDK-provided port.
 *
 * Consumers: the container `CMD` and `apify run`.
 *
 * Run-mode contract:
 * - Standby run on the platform (`APIFY_META_ORIGIN=STANDBY`) → serve forever.
 * - Local `apify run` → serve, so endpoints can be exercised during development.
 * - Ordinary platform run (pressing Start) → exit immediately with a pointer to
 *   the Standby URL, rather than burning compute on an idle server.
 */

import { Actor, log } from 'apify'
import { readConfig } from './config.ts'
import type { ChargeFn, LogFn } from './server.ts'
import { createApp } from './server.ts'

/**
 * Maps the injected log levels onto the Apify logger.
 *
 * @param level - Severity to emit
 * @param message - Human-readable message
 * @param data - Optional structured context
 *
 * @remarks Uses the Apify logger (not `console`) so credentials are censored in
 * output and lines are attributed to this Actor run.
 *
 * @internal
 */
const logFn: LogFn = (level, message, data) => {
  if (level === 'debug') return log.debug(message, data)
  if (level === 'warning') return log.warning(message, data)
  if (level === 'error') return log.error(message, data)
  return log.info(message, data)
}

/**
 * Charges the caller through the Apify pay-per-event API.
 *
 * @param eventName - Configured event name
 * @param count - Number of events to charge
 * @returns Whether the caller's budget for this event is exhausted
 *
 * @internal
 */
const charge: ChargeFn = async (eventName, count) => {
  const result = await Actor.charge({ eventName, count })
  return { eventChargeLimitReached: result.eventChargeLimitReached }
}

await Actor.init()

const config = readConfig()
const isStandby = process.env.APIFY_META_ORIGIN === 'STANDBY'
const isPlatformRun = Actor.isAtHome()

if (isPlatformRun && !isStandby) {
  const standbyUrl = process.env.ACTOR_STANDBY_URL ?? 'the Actor Standby tab'
  log.warning(
    `you-mcp is a Standby-only Actor and does not produce results in a normal run. Use the Standby URL instead: ${standbyUrl}`,
  )
  await Actor.exit()
}

const port = Actor.config.get('containerPort')
const app = createApp({ config, charge, log: logFn })

const server = Bun.serve({
  port,
  // Deep research responses can stream for minutes; Bun's default 10s idle
  // timeout would cut the SSE stream short.
  idleTimeout: 255,
  fetch: (request) => app.fetch(request),
})

Actor.on('aborting', async () => {
  log.info('Aborting: stopping the MCP HTTP server')
  server.stop(true)
  await Actor.exit()
})

log.info('you-mcp is serving', {
  port,
  standby: isStandby,
  upstream: config.upstreamMcpUrl,
  chargingEnabled: config.chargingEnabled,
  actorKeyConfigured: config.actorApiKey !== undefined,
})
