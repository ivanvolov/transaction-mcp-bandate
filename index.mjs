#!/usr/bin/env node

import dotenv from "dotenv";
import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import express from "express";
import inquirer from "inquirer";
import TelegramBot from "node-telegram-bot-api";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import SafeApiKit from "@safe-global/api-kit";

import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_QUEUE = join(__dirname, "ledger-queue.json");

dotenv.config();

const args = process.argv.slice(2);
let mode = null;
let serveLedger = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--mode" && args[i + 1]) {
    mode = args[i + 1];
    i++;
  } else if (args[i] === "--ledger") {
    serveLedger = true;
  }
}

if (!mode && serveLedger) {
  mode = "ledger";
}

if (!["mcp", "dev", "telegram", "ledger"].includes(mode)) {
  console.error("Usage: node index.mjs --mode <mcp|dev|telegram|ledger> [--ledger]");
  process.exit(1);
}

const PORT = Number(process.env.MCP_PORT) || 3847;
const LEDGER_UI_PORT = Number(process.env.LEDGER_PORT) || 3848;
const { safeAddress, chainId } = config;
const chainIdBn = BigInt(chainId);

const apiKey = process.env.SAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("SAFE_API_KEY missing in .env");
  process.exit(1);
}
const apiKit = new SafeApiKit({ chainId: chainIdBn, apiKey });

// ── helpers ─────────────────────────────────────────────────────────────
async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

async function writeJson(path, obj) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  await rename(tmp, path);
}

function summarize(tx) {
  return {
    safeTxHash: tx.safeTxHash,
    nonce: tx.nonce,
    to: tx.to,
    value: tx.value,
    data: tx.data ? `${tx.data.slice(0, 66)}…` : null,
    operation: tx.operation,
    submissionDate: tx.submissionDate,
    confirmationsRequired: tx.confirmationsRequired,
    confirmationsCount: tx.confirmations?.length ?? 0,
    proposer: tx.proposer,
    decodedMethod: tx.dataDecoded?.method ?? null,
  };
}

async function listPending() {
  const list = await apiKit.getMultisigTransactions(safeAddress, {
    executed: false,
    limit: 100,
    ordering: "-submissionDate",
  });
  return (list.results ?? []).filter((tx) => !tx.isExecuted);
}

async function appendQueue(tx, source) {
  await mkdir(dirname(LEDGER_QUEUE), { recursive: true });
  const q = await readJson(LEDGER_QUEUE, { items: [] });
  if (q.items.some((i) => i.safeTxHash === tx.safeTxHash)) return;
  q.items.push({
    safeTxHash: tx.safeTxHash,
    nonce: tx.nonce,
    to: tx.to,
    value: tx.value,
    submissionDate: tx.submissionDate,
    addedAt: new Date().toISOString(),
    source,
  });
  await writeJson(LEDGER_QUEUE, q);
}

async function decideTransaction(safeTxHash, decision, source) {
  if (decision === "approve") {
    const tx = await apiKit.getTransaction(safeTxHash);
    if (!tx?.safeTxHash) throw new Error(`Tx not found: ${safeTxHash}`);
    await appendQueue(tx, source);
    return true;
  }
  return false;
}

// ── modes ─────────────────────────────────────────────────────────────

async function startMcpServer() {
  const mcpServer = new McpServer({ name: "safe-agent", version: "1.0.0" });

  mcpServer.registerTool(
    "safe_list_pending",
    {
      description: `List unexecuted (pending) multisig transactions. Safe ${safeAddress}, chain ${chainId}.`,
      inputSchema: {},
    },
    async () => {
      const txs = await listPending();
      const payload = {
        safeAddress,
        chainId,
        count: txs.length,
        transactions: txs.map(summarize),
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  mcpServer.registerTool(
    "safe_decide_transaction",
    {
      description: "Approve or reject a pending Safe tx. Approve → added to Ledger web queue for signing. Reject → no-op.",
      inputSchema: {
        safeTxHash: z.string().describe("0x-prefixed Safe tx hash"),
        decision: z.enum(["approve", "reject"]).describe("approve or reject"),
      },
    },
    async ({ safeTxHash, decision }) => {
      await decideTransaction(safeTxHash, decision, "mcp");
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, safeTxHash, decision }, null, 2) }],
      };
    }
  );

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/mcp") {
      if (req.method === "POST") {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await mcpServer.server.connect(transport);
        await transport.handleRequest(req, res);
        return;
      }
    }
    res.writeHead(404).end("not found\n");
  });

  httpServer.listen(PORT, () => {
    console.log(`[MCP] Server listening on http://127.0.0.1:${PORT}/mcp`);
  });
}

async function startDevMode() {
  console.log("Fetching pending transactions...");
  const txs = await listPending();
  if (txs.length === 0) {
    console.log("No pending transactions.");
    return;
  }

  for (const tx of txs) {
    const summary = summarize(tx);
    console.log("\nTransaction:", JSON.stringify(summary, null, 2));
    const { decision } = await inquirer.prompt([
      {
        type: "list",
        name: "decision",
        message: `Decide on tx ${tx.safeTxHash}:`,
        choices: ["approve", "reject", "skip"],
      },
    ]);

    if (decision === "approve" || decision === "reject") {
      await decideTransaction(tx.safeTxHash, decision, "dev");
      console.log(`Decision '${decision}' recorded.`);
    }
  }
  console.log("All pending transactions processed.");
}

async function startTelegramMode() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error("TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_CHAT_ID required in .env");
    process.exit(1);
  }

  const bot = new TelegramBot(token, { polling: true });
  console.log("[Telegram] Bot started, polling for new transactions...");

  const seenTxs = new Set();

  setInterval(async () => {
    try {
      const txs = await listPending();
      for (const tx of txs) {
        if (!seenTxs.has(tx.safeTxHash)) {
          seenTxs.add(tx.safeTxHash);
          const msg = `New pending transaction:\nHash: ${tx.safeTxHash}\nTo: ${tx.to}\nValue: ${tx.value}`;
          const opts = {
            reply_markup: {
              inline_keyboard: [
                [
                  { text: "Approve", callback_data: `approve:${tx.safeTxHash}` },
                  { text: "Reject", callback_data: `reject:${tx.safeTxHash}` }
                ]
              ]
            }
          };
          bot.sendMessage(chatId, msg, opts);
        }
      }
    } catch (e) {
      console.error("[Telegram] Error polling:", e.message);
    }
  }, 10000);

  bot.on("callback_query", async (query) => {
    const [action, safeTxHash] = query.data.split(":");
    if (action === "approve" || action === "reject") {
      try {
        await decideTransaction(safeTxHash, action, "telegram");
        bot.answerCallbackQuery(query.id, { text: `Transaction ${action}d` });
        bot.editMessageText(`Transaction ${safeTxHash} ${action}d.`, {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id
        });
      } catch (e) {
        bot.answerCallbackQuery(query.id, { text: `Error: ${e.message}` });
      }
    }
  });
}

function startLedgerServer() {
  const app = express();

  app.use(express.static(join(__dirname, "ledger-ui")));
  
  app.get("/api/ledger-queue", async (req, res) => {
    const q = await readJson(LEDGER_QUEUE, { items: [] });
    res.json(q);
  });

  app.delete("/api/ledger-queue/:hash", async (req, res) => {
    const q = await readJson(LEDGER_QUEUE, { items: [] });
    q.items = q.items.filter(i => i.safeTxHash !== req.params.hash);
    await writeJson(LEDGER_QUEUE, q);
    res.json({ ok: true });
  });

  app.listen(LEDGER_UI_PORT, () => {
    console.log(`[Ledger] UI served at http://127.0.0.1:${LEDGER_UI_PORT}`);
  });
}

// ── main ─────────────────────────────────────────────────────────────
async function main() {
  if (mode === "mcp") {
    await startMcpServer();
  } else if (mode === "dev") {
    await startDevMode();
  } else if (mode === "telegram") {
    await startTelegramMode();
  }

  if (serveLedger || mode === "ledger") {
    startLedgerServer();
  }
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
