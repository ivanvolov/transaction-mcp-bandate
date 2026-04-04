# Safe MCP server

One MCP server with two tools and two modes. Runs over HTTP so you can ngrok it.

## Tools

| Tool | What it does |
|------|-------------|
| `safe_list_pending` | List unexecuted multisig txs for the Safe in `config.mjs`. |
| `safe_decide_transaction` | Approve (→ Ledger queue) or reject (no-op, tx stays pending). |

Reject is intentionally a no-op — the tx stays on-chain and keeps showing in `list_pending` until approved or handled elsewhere.

## Modes

| Mode | How to run | Behavior on `decide` |
|------|-----------|---------------------|
| **Normal** | `npm run mcp` | Trusts the caller's `decision` argument. |
| **Dev** | `npm run mcp:dev` | Prompts **you** on `/dev/tty` (`Approve? [y/N]`), ignores the agent's decision. |

## Setup

```bash
cd safe_integration
cp .env.example .env   # add SAFE_API_KEY
npm install
npm run mcp            # starts on http://127.0.0.1:3847/mcp
```

Override the port with `MCP_PORT` env var (default `3847`).

## Expose via ngrok

```bash
ngrok http 3847
```

Then use the ngrok URL + `/mcp` as your MCP endpoint, e.g. `https://abc123.ngrok-free.app/mcp`.

## MCP client config (Streamable HTTP)

```json
{
  "mcpServers": {
    "safe-agent": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

For ngrok, replace the URL with your ngrok forwarding address.

## Endpoints

| Path | Method | Purpose |
|------|--------|---------|
| `/mcp` | POST / GET / DELETE | MCP Streamable HTTP transport |
| `/health` | GET | Health check — returns Safe address + chain |

## Files

- `config.mjs` — Safe address + chain.
- `mcp/safeMcp.mjs` — the whole server.
- `../agent/ledger-queue.json` — approve writes here; `leger_integration` reads it.
