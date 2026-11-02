# You.com MCP Server

An [Apify Standby](https://docs.apify.com/platform/actors/running/standby) Actor that serves the
[You.com MCP server](https://you.com/docs/agents/mcp-server) over the MCP Streamable HTTP transport.

It gives your LLM or agent **live web search**, **full page content extraction**, **citation-backed
research**, **finance research**, **account balance lookup**, and **agent/tool discovery** through one
stable HTTPS endpoint — no local process to run and no MCP client to install. This is a hosted **MCP
server** and **API endpoint**, not a scraper: it produces no dataset, and every call is answered in real time.

## Why use this Actor?

- **Zero-install MCP.** Point any MCP client at one URL. Nothing to `npx`, no stdio process to supervise.
- **Always warm.** Apify Standby keeps the server ready, so there is no cold-start latency per query.
- **Bring your own key, or don't.** Use the Actor operator's You.com key, supply your own, or run
  keyless with the free profile.
- **Scoped tools.** Expose only `you-search` for a cheap agent, or only `you-research` on a dedicated
  endpoint, and give high-impact tools their own endpoint and budget.
- **Standby platform features.** Stable hostname, automatic scaling across runs, and Apify's
  [scheduling, API, webhooks, and monitoring](https://docs.apify.com/platform/actors/running) around it.

## Available tools

| Tool           | What it does                                                                    | Notes                               |
| -------------- | ------------------------------------------------------------------------------- | ----------------------------------- |
| `you-search`   | Live web search returning ranked results, optionally crawling full page content | The main workhorse                  |
| `you-contents` | Extracts a page's content as Markdown or HTML                                   | Use HTML for layout fidelity        |
| `you-research` | Multi-step, citation-backed research with configurable effort                   | Slowest; can stream for minutes     |
| `you-finance`  | Finance research: financials, filings, earnings, valuation, macro               | Dedicated endpoint available        |
| `you-balance`  | Remaining You.com credit balance for the key owner, in cents                    | **Caller key required** (see below) |
| `you-discover` | Discovers AI agents, MCP servers, A2A agents, and skills                        | Keyless-capable                     |

There is no `you-answer` tool.

### `you-balance` requires your own key

`you-balance` reports the **billing balance of whichever You.com key performs the call**. Serving it with
the Actor operator's key would disclose that account's balance to any caller, so this Actor refuses to do
it: the tool is hidden from `tools/list` and rejected on `tools/call` unless the request carries an
`X-YDC-API-Key` header. All other tools fall back to the operator key when you bring none.

## How to connect

Create or open the Actor, enable **Standby mode**, and copy the Standby URL from the **Standby** tab:
`https://<your-username>--you-com-mcp.apify.actor`.

### MCP client configuration

```json
{
  "mcpServers": {
    "you-com": {
      "url": "https://your-username--you-com-mcp.apify.actor/mcp",
      "headers": {
        "Authorization": "Bearer <APIFY_TOKEN>",
        "X-YDC-API-Key": "<YDC_API_KEY>"
      }
    }
  }
}
```

Drop the `X-YDC-API-Key` header to use the Actor operator's key, or call
`.../mcp?profile=free` for the keyless tool set. Because you control both headers, you can safely give a
scoped Apify token to a third party without exposing your account.

### Authentication

Every request needs **both** of the following, unless noted:

| Credential          | Where it goes                                                    | Purpose                                                                         |
| ------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| **Apify token**     | `Authorization: Bearer <APIFY_TOKEN>`, or `?token=<APIFY_TOKEN>` | Authenticates you to the Actor. Required.                                       |
| **You.com API key** | `X-YDC-API-Key: <YDC_API_KEY>`                                   | Optional. Your key, instead of the operator's. Required only for `you-balance`. |

`Authorization: Bearer` is already taken by Apify authentication, which is why the You.com key travels in
`X-YDC-API-Key`. **The Apify token is never forwarded to You.com**, and `?token=` is stripped before
forwarding.

Clients that support the Machine Payments Protocol (x402) can instead pay per call by sending
`Authorization: Payment ...` and passing the Apify token as `?token=`.

## Endpoints

| Method           | Path            | Purpose                                                    |
| ---------------- | --------------- | ---------------------------------------------------------- |
| `GET`            | `/`             | Readiness probe. Always returns `200 OK`.                  |
| `POST`           | `/mcp`          | Full MCP endpoint; tools limited by profile and allowlist. |
| `GET` / `DELETE` | `/mcp`          | Server-to-client SSE stream / session termination.         |
| `POST`           | `/mcp/research` | `you-research` only.                                       |
| `POST`           | `/mcp/finance`  | `you-finance` only.                                        |

On `/mcp/research` and `/mcp/finance` the `tools` query parameter and `X-Allowed-Tools` header are
ignored, matching the upstream server. The profile ceiling still applies.

### Scoping tools

| Control             | Example                              | Effect                                                   |
| ------------------- | ------------------------------------ | -------------------------------------------------------- |
| `?profile=free`     | `/mcp?profile=free`                  | `you-search` + `you-discover`, keyless, 100 queries/day. |
| `?profile=discover` | `/mcp?profile=discover`              | `you-discover` only, keyless.                            |
| `?tools=`           | `/mcp?tools=you-search,you-contents` | Comma-separated allowlist.                               |
| `X-Allowed-Tools`   | `you-search,you-finance`             | Overrides `?tools=` when non-empty.                      |

`you-research` and `you-finance` are **not** in the default allowlist; request them explicitly. The
default set is `you-search`, `you-contents`, `you-balance`, `you-discover`.

## Example calls

Initialize:

```bash
curl -sS -X POST 'https://your-username--you-com-mcp.apify.actor/mcp?profile=free' \
  -H 'Authorization: Bearer <APIFY_TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

Search the web:

```bash
curl -sS -X POST 'https://your-username--you-com-mcp.apify.actor/mcp?profile=free' \
  -H 'Authorization: Bearer <APIFY_TOKEN>' \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"you-search","arguments":{"query":"grid-scale battery storage news","count":5}}}'
```

Responses arrive as `text/event-stream` (JSON-RPC messages in SSE `data:` lines) or plain JSON,
depending on your `Accept` header. Long-running calls such as `you-research` stream while they work, so
your client receives progress instead of waiting in silence.

## Input

This Actor takes **no initialization input** — it is a server, and all request data arrives over HTTP.
See the input tab for the (empty) schema. Configuration is entirely through environment variables:

| Variable                    | Default                   | Purpose                                                        |
| --------------------------- | ------------------------- | -------------------------------------------------------------- |
| `YDC_API_KEY`               | —                         | Actor-level You.com key used as the fallback. Set as a secret. |
| `YDC_MCP_UPSTREAM_URL`      | `https://api.you.com/mcp` | Upstream MCP base URL. Override to target staging.             |
| `YDC_PPE_CHARGING_ENABLED`  | `false`                   | Enables pay-per-event charging (events must exist in Console). |
| `YDC_FIRST_BYTE_TIMEOUT_MS` | `290000`                  | Deadline for the upstream response headers.                    |

`APIFY_TOKEN` must **not** be set by hand: the Apify platform provides it, and the local CLI resolves it
from your login.

## Output

There is no dataset. MCP responses are returned directly to the caller on the same HTTP connection, and
run logs and charges are the only per-call records kept. Downloading datasets does not apply to this Actor.

## How much will it cost?

This Actor runs in Standby mode, so you pay for the compute of the running server, plus Apify platform
usage. Idle time counts while the server is kept warm — raise the **idle timeout** in the Standby tab and
lower the **memory** setting to reduce cost, or create a Task to tune those per audience.

Two further costs apply:

- **You.com usage.** Calls made with the operator key consume that account's You.com credits. Callers who
  bring their own key pay You.com themselves and consume none of yours.
- **Pay-per-event (optional).** When `YDC_PPE_CHARGING_ENABLED=true` and the events are configured in
  Apify Console, successful `tools/call` requests are charged per tool
  (`you-search-call`, `you-contents-call`, `you-research-call`, `you-finance-call`, `you-discover-call`).
  Calls that fail, keyless-profile calls, and callers who pay You.com directly (their own key or x402)
  are never charged. When a caller's budget runs out, the server stops forwarding work.

## Local development

```bash
brew install apify-cli
apify login          # browser sign-in, or set APIFY_TOKEN for headless use
apify run            # starts the server on http://localhost:4321 with local storage
```

Always use `apify run` rather than `bun run start`: it sets up the Apify environment and storage. Then:

```bash
# Readiness probe
curl -i -H 'x-apify-container-server-readiness-probe: true' http://localhost:4321/

# Keyless round-trip
curl -sS -X POST 'http://localhost:4321/mcp?profile=free' \
  -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Quality gates:

```bash
bun test         # unit + integration tests against a stub upstream
bun run check    # Biome + strict TypeScript
```

Put local secrets in `.env` (git-ignored); see `.env.example`. For the platform, add a secret with
`apify secrets add ydcApiKey <value>` and reference it as `@ydcApiKey` from the Actor's environment
variables.

## Tips

- **Scope tightly.** Give each agent only the tools it needs: `?tools=you-search` is far cheaper than the
  full set, and it stops a model from invoking an expensive research run without being asked.
- **Separate expensive tools.** Use `/mcp/research` and `/mcp/finance` as dedicated endpoints so you can
  attach their own key, budget, or rate expectations.
- **Start keyless.** `?profile=free` needs no You.com account, which is the fastest way to validate a
  client configuration.
- **Prefer `you-search` with `extraction: "highlights"`.** It is much cheaper than fetching full pages
  you will not read.

## FAQ

### Do I need a You.com API key?

No, if you only use `you-search` and `you-discover` through `?profile=free` (100 queries/day), or if the
Actor operator has configured a key. Yes, for `you-research`, `you-finance`, `you-balance`, and for
avoiding the free daily limit.

### Can I use this without an Apify account?

Not for the hosted Standby URL — it requires an Apify token. For a fully keyless local setup, run the
upstream `npx @youdotcom-oss/mcp` instead.

### Why did `you-balance` disappear from the tool list?

Because the request carried no `X-YDC-API-Key`. That is deliberate: see
[`you-balance` requires your own key](#you-balance-requires-your-own-key).

### Does this Actor replace the You.com MCP server?

No. It is a proxy in front of it, so tool behaviour, parameters, and responses stay identical to
`https://api.you.com/mcp`, including the `profile`, `tools`, `/mcp/finance`, and `/mcp/research`
semantics. Swapping the base URL back to `api.you.com` should change nothing except authentication.

## Support

Report problems in the **Issues** tab. Include the run log, the JSON-RPC request, and whether you used
your own key — never paste API tokens. For You.com tool behaviour itself, see the
[You.com MCP server documentation](https://you.com/docs/agents/mcp-server).

## License

MIT — see [LICENSE](LICENSE).

---

Our Actors are ethical and do not extract any private user data, such as email addresses, gender, or
location. They only extract what the user has chosen to share publicly. However, you should be aware that
your results could contain personal data. Personal data is protected by the GDPR in the European Union and
by other regulations around the world. You should not process personal data unless you have a legitimate
reason to do so. If you are unsure whether your reason is legitimate, consult your lawyers.
