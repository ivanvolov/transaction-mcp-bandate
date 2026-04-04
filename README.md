# Safe MCP Server & Ledger Integration

One unified Node.js app to manage Safe multisig transactions with 4 different modes.

## Setup

1. Clone the repo and install dependencies:
```bash
npm install
```

2. Configure environment variables:
```bash
cp .env.example .env
```
Edit `.env` and add your `SAFE_API_KEY`. For Telegram mode, also add `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_CHAT_ID`.

## Modes

The app supports 4 modes, selected via command line flags:

### 1. MCP Mode (`--mode mcp`)
Exposes an MCP server over HTTP (Streamable HTTP transport) with tools: `safe_list_pending` and `safe_decide_transaction`.
An external AI agent connects and makes decisions.
When approved, the tx goes to `ledger-queue.json`. When rejected, it's a no-op.
```bash
node index.mjs --mode mcp
```

### 2. Dev Mode (`--mode dev`)
Interactive command line interface. Lists pending transactions and prompts you to approve/reject using arrow keys.
When approved, tx goes to `ledger-queue.json`.
```bash
node index.mjs --mode dev
```

### 3. Telegram Mode (`--mode telegram`)
Polls for new pending transactions and sends details to a Telegram bot.
You can approve/reject via inline buttons in Telegram.
Needs `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_CHAT_ID` in `.env`.
When approved, tx goes to `ledger-queue.json`.
```bash
node index.mjs --mode telegram
```

### 4. Ledger Mode (`--mode ledger`)
Serves the existing Ledger frontend as a static Express app.
The frontend reads `ledger-queue.json` and lets you sign with a Ledger hardware wallet.
```bash
node index.mjs --mode ledger
```

### Combined Modes
You can run the Ledger UI alongside any other mode by adding the `--ledger` flag.
For example, to run the MCP server and serve the Ledger UI simultaneously:
```bash
node index.mjs --mode mcp --ledger
```

In combined mode, the MCP server runs on `MCP_PORT` (default 3847) and the Ledger UI runs on `LEDGER_PORT` (default 3848).

## MCP Tools

| Tool | Description |
|------|-------------|
| `safe_list_pending` | List unexecuted multisig txs for the configured Safe |
| `safe_decide_transaction` | Approve (→ Ledger queue) or reject (no-op, tx stays pending) |

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
| `MCP_PORT` | No | `3847` | Port for the MCP HTTP server |
| `LEDGER_PORT` | No | `3848` | Port for the Ledger UI server |
| `TELEGRAM_BOT_TOKEN` | Telegram only | — | Telegram bot token |
| `ADMIN_TELEGRAM_CHAT_ID` | Telegram only | — | Telegram chat ID to receive notifications |

## Config

Safe address, chain ID, and other constants are located in `config.mjs`.

| Key | Value |
|-----|-------|
| `safeAddress` | `0xe4522AcE60ccE4658751024310FF04f84daf8149` |
| `chainId` | `42161` (Arbitrum One) |
| `ownerAddress` | `0x6F4F4da5DD8546c625Ab3a3aF6B4797B66f56f14` |
| `signerAddress` | `0x156D1aBD1F207f73a6ef13EF22E862Fc141156bD` |

## Files

| File | Purpose |
|------|---------|
| `index.mjs` | Single entry point with all mode logic |
| `config.mjs` | Safe address, chain, and owner config |
| `.env.example` | Environment variable template |
| `ledger-ui/` | Built Ledger frontend (static files) |
| `package.json` | Single root package.json |
| `ledger-queue.json` | Approved transactions waiting for Ledger signing (auto-created) |
