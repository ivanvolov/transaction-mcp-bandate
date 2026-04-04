# Safe MCP server

One MCP server with two tools and two modes. That's it.

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
```

## Cursor MCP config (stdio)

```json
{
  "mcpServers": {
    "safe-agent": {
      "command": "node",
      "args": ["/FULL/PATH/safe_integration/mcp/safeMcp.mjs"],
      "cwd": "/FULL/PATH/safe_integration"
    }
  }
}
```

Add `"--dev"` to `args` for dev mode.

## Files

- `config.mjs` — Safe address + chain.
- `mcp/safeMcp.mjs` — the whole server.
- `../agent/ledger-queue.json` — approve writes here; `leger_integration` reads it.
