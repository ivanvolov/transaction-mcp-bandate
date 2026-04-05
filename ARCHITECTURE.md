# Architecture & Requirements

This document is the single source of truth for all features, requirements, and design decisions.
**Read this before changing anything.**

---

## Overview

A Node.js app that manages Safe multisig transactions. It combines:
- A **decision layer** (who decides approve/reject): MCP server or interactive CLI
- A **confirmation layer** (how the decision gets executed): Ledger hardware wallet or Telegram bot
- A **rules engine** that auto-approves or auto-rejects transactions based on `rules.yml`

Everything runs from a single entry point: `index.mjs`.

---

## Two-Flag System

The app requires **exactly two flags** to run. One input mode flag + one confirmation mode flag.

### Input Mode (choose one)

| Flag | What it does |
|------|-------------|
| `--mcp` | Starts an MCP server (Streamable HTTP transport) on `MCP_PORT`. An external AI agent connects and calls tools to list pending txs and approve/reject them. |
| `--dev` | Starts an interactive CLI. Lists pending transactions, shows rules verdict, prompts with arrow keys to approve/reject/skip. |

### Confirmation Mode (choose one)

| Flag | What it does |
|------|-------------|
| `--ledger` | Both approvals AND rejections go to `ledger-queue.json`. The Ledger UI at `/ui` shows them. You connect a Ledger hardware wallet and sign each one. Rejections are signed as rejection transactions. |
| `--telegram` | Rejections are sent to a Telegram bot with inline buttons. The admin can override (approve) or confirm the rejection. Approvals still go to the Ledger queue. Requires `TELEGRAM_BOT_TOKEN` and `ADMIN_TELEGRAM_CHAT_ID` in `.env`. |

### Valid combinations

```
node index.mjs --mcp --ledger       # AI decides, sign everything via Ledger
node index.mjs --mcp --telegram     # AI decides, rejections reviewed in Telegram
node index.mjs --dev --ledger       # Human decides via CLI, sign via Ledger
node index.mjs --dev --telegram     # Human decides via CLI, rejections via Telegram
```

npm scripts: `mcp:ledger`, `mcp:telegram`, `dev:ledger`, `dev:telegram`.

---

## Transaction Flow

```
1. Fetch pending Safe multisig transactions from Safe Transaction Service API
2. For each transaction, evaluate against rules.yml:
   a. auto-approve  →  skip to step 3 with decision=approve
   b. auto-reject   →  skip to step 3 with decision=reject
   c. ask           →  pass to input mode (MCP agent or CLI human) for decision
3. Route based on confirmation mode:
   ┌─────────────────────────────────────────────────────────────┐
   │ --ledger mode:                                              │
   │   approve → add to ledger-queue.json (decision: "approve")  │
   │   reject  → add to ledger-queue.json (decision: "reject")   │
   │   → User opens Ledger UI, connects Ledger, signs tx         │
   ├─────────────────────────────────────────────────────────────┤
   │ --telegram mode:                                            │
   │   approve → add to ledger-queue.json                        │
   │   reject  → send to Telegram bot with Override/Confirm btns │
   │     → Override  = approve + add to ledger-queue.json        │
   │     → Confirm   = tx stays pending on-chain (no-op)         │
   └─────────────────────────────────────────────────────────────┘
4. Ledger UI: user connects Ledger via EIP-6963 provider discovery,
   signs EIP-712 typed data (SafeTx), signature submitted to Safe API
5. After signing, item is removed from ledger-queue.json
```

---

## Rules Engine (`rules.yml`)

Transactions are evaluated top-down. First match wins.

### Rule types

1. **Daily caps** (checked first, hard limits):
   - `max_total_value`: total native value approved per day (wei)
   - `max_tx_count`: max number of approved transactions per day
   - If exceeded → auto-reject

2. **Whitelist** (trusted addresses):
   - `address`: the destination address
   - `label`: human-readable name
   - `max_value_per_tx`: optional per-tx value limit (wei)
   - If address matches and within limits → auto-approve
   - If address matches but over limit → auto-reject

3. **Known contracts** (DeFi protocols etc.):
   - `address`: contract address
   - `label`: human-readable name
   - `allowed_methods`: list of allowed decoded method names
   - `max_value_per_tx`: optional native value limit
   - If method is in allowed list → auto-approve
   - If method is NOT in allowed list → auto-reject
   - If no method restrictions → auto-approve

4. **Default action** (`default_action`):
   - `"ask"` (default): defer to agent/human
   - `"reject"`: auto-reject anything not explicitly allowed

### Daily stats tracking

- Stored in `daily-stats.json`
- Resets automatically each day
- Tracks `totalValue` (sum of approved tx values in wei) and `txCount`

---

## MCP Tools

Available when running with `--mcp`:

| Tool | Parameters | Description |
|------|-----------|-------------|
| `safe_list_pending` | none | Lists all pending (unexecuted) multisig txs. Each includes a `rulesVerdict` showing what the rules engine decided. |
| `safe_decide_transaction` | `safeTxHash` (string), `decision` ("approve"/"reject"), `reason` (optional string) | Approve or reject a tx. Routing depends on confirmation mode. |
| `safe_get_rules` | none | Returns current `rules.yml` as both parsed JSON and raw YAML. |
| `safe_update_rules` | `yaml_content` (string) | Overwrites `rules.yml` with new content. Validates YAML before writing. |

MCP endpoint: `http://127.0.0.1:{MCP_PORT}/mcp` (Streamable HTTP transport).

---

## Express Server (always runs)

Single Express app on `MCP_PORT` (default 3847). Serves:

| Route | Method | Purpose |
|-------|--------|---------|
| `/ui` | GET | Static files for Ledger signing UI (`ledger-ui/index.html`) |
| `/mcp` | POST/GET/DELETE | MCP endpoint (only active in `--mcp` mode) |
| `/api/ledger-queue` | GET | Returns the current Ledger queue |
| `/api/ledger-queue/:hash` | DELETE | Removes an item from the queue |
| `/api/safe-tx/:hash` | GET | Fetches full tx details + EIP-712 typed data for signing |
| `/api/safe-tx/:hash/confirm` | POST | Submits a signature to Safe API, removes from queue |
| `/health` | GET | Health check, returns Safe address and chain ID |

---

## Ledger UI (`ledger-ui/index.html`)

Single HTML file. No build step. No bundler. Human-readable code.

**Requirements:**
- Plain HTML + inline CSS + inline `<script type="module">`
- NO minified/bundled JavaScript files
- NO hardcoded token amounts (no USDC, no "propose transfer" — it only signs queued transactions)
- Uses `@aspect-build/ledger-connect-kit` via ESM CDN for EIP-6963 Ledger provider discovery
- Shows the Ledger queue with each item clearly marked as APPROVE or REJECT
- Shows source (who made the decision: mcp, dev, rules, telegram-override)
- Shows tx details: hash, nonce, to, value, method, timestamp
- Connect Ledger button → `eth_requestAccounts`
- Sign button per queue item → `eth_signTypedData_v4` with EIP-712 SafeTx typed data
- After successful signing, submits to `/api/safe-tx/:hash/confirm` and refreshes queue
- Auto-refreshes queue every 10 seconds

---

## Ledger Queue (`ledger-queue.json`)

JSON file, auto-created. Structure:

```json
{
  "items": [
    {
      "safeTxHash": "0x...",
      "nonce": 42,
      "to": "0x...",
      "value": "0",
      "data": "0xa9059cbb...",
      "decodedMethod": "transfer",
      "submissionDate": "2025-04-05T...",
      "addedAt": "2025-04-05T...",
      "decision": "approve",
      "source": "mcp"
    }
  ]
}
```

Fields:
- `decision`: `"approve"` or `"reject"` — displayed as badge in UI
- `source`: who made the decision (`mcp`, `dev`, `rules:{ruleName}`, `telegram-override`)

Written atomically (write to `.tmp`, then rename).

---

## Telegram Bot (only in `--telegram` mode)

- Uses `node-telegram-bot-api` with long polling
- Sends rejection notifications to `ADMIN_TELEGRAM_CHAT_ID`
- Each message includes tx details and two inline buttons:
  - **Override → approve**: calls `approve()`, adds to Ledger queue
  - **Confirm reject**: tx stays pending on-chain (no-op)
- Uses short keys (first 10 chars of hash) for callback data
- Bot is NOT started unless `--telegram` flag is passed

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SAFE_API_KEY` | Always | — | Safe Transaction Service API key |
| `MCP_PORT` | No | `3847` | Port for Express server (API + UI + MCP) |
| `TELEGRAM_BOT_TOKEN` | `--telegram` only | — | Telegram bot token |
| `ADMIN_TELEGRAM_CHAT_ID` | `--telegram` only | — | Chat ID for rejection notifications |

---

## Config (`config.mjs`)

Static config, not environment-dependent:

| Key | Value | Description |
|-----|-------|-------------|
| `safeAddress` | `0xe4522AcE60ccE4658751024310FF04f84daf8149` | The Safe multisig address |
| `chainId` | `42161` | Arbitrum One |
| `ownerAddress` | `0x6F4F4da5DD8546c625Ab3a3aF6B4797B66f56f14` | Safe owner address |
| `signerAddress` | `0x156D1aBD1F207f73a6ef13EF22E862Fc141156bD` | Ledger signer address |

---

## File Map

| File | Purpose |
|------|---------|
| `index.mjs` | Single entry point. All modes, server, MCP, CLI, Telegram, rules engine. |
| `config.mjs` | Safe address, chain ID, owner/signer addresses. |
| `rules.yml` | Firewall rules. Editable manually or via `safe_update_rules` MCP tool. |
| `.env` / `.env.example` | Environment variables (API keys, tokens, ports). |
| `ledger-ui/index.html` | Ledger signing UI. Plain HTML, no build step. |
| `ledger-queue.json` | Queue of transactions waiting for Ledger signing. Auto-created. |
| `daily-stats.json` | Daily approval counters for rate limiting. Auto-created, resets daily. |
| `package.json` | Dependencies and npm scripts. |

---

## Dependencies

| Package | Why |
|---------|-----|
| `@modelcontextprotocol/sdk` | MCP server (Streamable HTTP transport) |
| `@safe-global/api-kit` | Safe Transaction Service API client |
| `express` | HTTP server for API, UI, and MCP |
| `inquirer` | Interactive CLI prompts (arrow-key selection) |
| `node-telegram-bot-api` | Telegram bot for rejection notifications |
| `zod` | MCP tool input schema validation |
| `js-yaml` | Parse and write `rules.yml` |
| `dotenv` | Load `.env` file |

---

## Non-Requirements (things this app does NOT do)

- Does NOT propose new transactions (no "send 1 USDC" or any token transfer feature)
- Does NOT execute transactions on-chain (only signs/confirms them on the Safe API)
- Does NOT have a build step for the UI (no Vite, no webpack, no bundler)
- Does NOT require both Telegram and Ledger at the same time — you pick one confirmation mode
- Does NOT store private keys — signing happens on the Ledger hardware device
