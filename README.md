# Safe MCP Server & Ledger Integration

One unified Node.js app to manage Safe multisig transactions.

## Setup

1. Clone the repo and install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
```
Edit `.env` and add your `SAFE_API_KEY`. For Telegram notifications, also add `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_CHAT_ID`.

## How to Run

The app requires **two flags**: an input mode (how transactions are decided) and a confirmation mode (how they are signed).

### Input Modes

| Flag | Description |
|------|-------------|
| `--mcp` | Starts an MCP server. An external AI agent connects and decides on transactions. |
| `--dev` | Interactive CLI. Lists pending transactions, you approve/reject with arrow keys. |

### Confirmation Modes

| Flag | Description |
|------|-------------|
| `--ledger` | Approved and rejected txs go to a Ledger queue. Open the UI, connect Ledger, sign. |
| `--telegram` | Rejected txs go to a Telegram bot for human review. Approve override available. |

### npm scripts

```bash
npm run mcp:ledger      # AI agent decides via MCP, sign via Ledger
npm run mcp:telegram    # AI agent decides via MCP, review via Telegram
npm run dev:ledger      # You decide via CLI, sign via Ledger
npm run dev:telegram    # You decide via CLI, review via Telegram
```

Or run directly:
```bash
node index.mjs --mcp --ledger
node index.mjs --dev --telegram
```

## Flow

### With `--ledger`
```
Pending Safe tx
  → rules.yml evaluation (auto-approve / auto-reject / ask human)
  → Decision made (via MCP agent or CLI)
     → Approve → added to Ledger queue
     → Reject  → added to Ledger queue (as rejection tx)
  → Open Ledger UI at http://127.0.0.1:3847/ui
  → Connect Ledger hardware wallet → sign
```

### With `--telegram`
```
Pending Safe tx
  → rules.yml evaluation
  → Decision made
     → Approve → added to Ledger queue
     → Reject  → sent to Telegram bot for human review
       → Override → approve and add to Ledger queue
       → Confirm reject → tx stays pending on-chain
```

## MCP Tools

| Tool | Description |
|------|-------------|
| `safe_list_pending` | List unexecuted multisig txs for the configured Safe |
| `safe_decide_transaction` | Approve or reject a pending tx (both go to Ledger queue) |
| `safe_get_rules` | Read the current firewall rules (rules.yml) |
| `safe_update_rules` | Update the firewall rules |

## MCP Client Config

```json
{
  "mcpServers": {
    "safe-agent": {
      "url": "http://127.0.0.1:3847/mcp"
    }
  }
}
```

## Expose via ngrok

```bash
ngrok http 3847
```

Then use the ngrok URL + `/mcp` as your MCP endpoint.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SAFE_API_KEY` | Yes | — | Safe Transaction Service API key |
| `MCP_PORT` | No | `3847` | Port for the HTTP server (MCP + Ledger UI) |
| `TELEGRAM_BOT_TOKEN` | No | — | Telegram bot token (for notifications) |
| `ADMIN_TELEGRAM_CHAT_ID` | No | — | Telegram chat ID for notifications |

## Config

Safe address, chain ID, and other constants are in `config.mjs`.

| Key | Value |
|-----|-------|
| `safeAddress` | `0xe4522AcE60ccE4658751024310FF04f84daf8149` |
| `chainId` | `42161` (Arbitrum One) |
| `ownerAddress` | `0x6F4F4da5DD8546c625Ab3a3aF6B4797B66f56f14` |
| `signerAddress` | `0x156D1aBD1F207f73a6ef13EF22E862Fc141156bD` |

## Files

| File | Purpose |
|------|---------|
| `index.mjs` | Single entry point — MCP server, dev CLI, Ledger API, Telegram bot |
| `config.mjs` | Safe address, chain, and owner config |
| `rules.yml` | Firewall rules (whitelist, known contracts, daily caps) |
| `.env.example` | Environment variable template |
| `ledger-ui/index.html` | Ledger signing UI (plain HTML, no build step) |
| `ledger-queue.json` | Transactions waiting for Ledger signing (auto-created) |
| `daily-stats.json` | Daily approval stats for rate limiting |
