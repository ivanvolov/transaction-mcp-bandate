#!/usr/bin/env node

import dotenv from "dotenv";
import http from "node:http";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
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

// ── arg parsing ───────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));

const inputMode   = args.has("--mcp") ? "mcp" : args.has("--dev") ? "dev" : null;
const confirmMode = args.has("--ledger") ? "ledger" : args.has("--telegram") ? "telegram" : null;

if (!inputMode || !confirmMode) {
  const lines = [
    "Error: both an input flag and a confirmation flag are required.",
    "",
    "  Input flags (how transactions are read/decided):",
    "    --mcp        MCP server for AI agents (HTTP, Streamable HTTP transport)",
    "    --dev        Interactive CLI with arrow-key approve/reject",
    "",
    "  Confirmation flags (how approved transactions are signed):",
    "    --ledger     Serve the Ledger signing UI",
    "    --telegram   Send to Telegram bot with inline approve/reject buttons",
    "",
    "  Valid combinations:",
    "    node index.mjs --mcp --ledger",
    "    node index.mjs --mcp --telegram",
    "    node index.mjs --dev --ledger",
    "    node index.mjs --dev --telegram",
  ];
  console.error(lines.join("\n"));
  process.exit(1);
}

// ── config ────────────────────────────────────────────────────────────────
const MCP_PORT    = Number(process.env.MCP_PORT)    || 3847;
const LEDGER_PORT = Number(process.env.LEDGER_PORT) || 3848;

const { safeAddress, chainId } = config;
const chainIdBn = BigInt(chainId);

const apiKey = process.env.SAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("Error: SAFE_API_KEY is missing. Add it to your .env file.");
  process.exit(1);
}
const apiKit = new SafeApiKit({ chainId: chainIdBn, apiKey });

// ── shared helpers ────────────────────────────────────────────────────────
async function readJson(filePath, fallback) {
  try { return JSON.parse(await readFile(filePath, "utf8")); }
  catch { return fallback; }
}

async function writeJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  await writeFile(tmp, JSON.stringify(obj, null, 2) + "\n", "utf8");
  await rename(tmp, filePath);
}

function summarize(tx) {
  return {
    safeTxHash:           tx.safeTxHash,
    nonce:                tx.nonce,
    to:                   tx.to,
    value:                tx.value,
    data:                 tx.data ? `${tx.data.slice(0, 66)}…` : null,
    operation:            tx.operation,
    submissionDate:       tx.submissionDate,
    confirmationsRequired: tx.confirmationsRequired,
    confirmationsCount:   tx.confirmations?.length ?? 0,
    proposer:             tx.proposer,
    decodedMethod:        tx.dataDecoded?.method ?? null,
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
    safeTxHash:     tx.safeTxHash,
    nonce:          tx.nonce,
    to:             tx.to,
    value:          tx.value,
    submissionDate: tx.submissionDate,
    addedAt:        new Date().toISOString(),
    source,
  });
  await writeJson(LEDGER_QUEUE, q);
}

// Approve → write to ledger-queue.json. Reject → no-op.
async function approve(safeTxHash, source) {
  const tx = await apiKit.getTransaction(safeTxHash);
  if (!tx?.safeTxHash) throw new Error(`Tx not found: ${safeTxHash}`);
  await appendQueue(tx, source);
}

// ── input mode: MCP ───────────────────────────────────────────────────────
async function startMcpInput() {
  const mcpServer = new McpServer({ name: "safe-agent", version: "1.0.0" });

  mcpServer.registerTool(
    "safe_list_pending",
    {
      description: `List unexecuted (pending) multisig transactions for Safe ${safeAddress} on chain ${chainId}.`,
      inputSchema: {},
    },
    async () => {
      const txs = await listPending();
      const payload = { safeAddress, chainId, count: txs.length, transactions: txs.map(summarize) };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  mcpServer.registerTool(
    "safe_decide_transaction",
    {
      description:
        "Approve or reject a pending Safe tx. " +
        "Approve → added to Ledger queue for signing. " +
        "Reject → no-op; tx stays pending.",
      inputSchema: {
        safeTxHash: z.string().describe("0x-prefixed Safe tx hash"),
        decision:   z.enum(["approve", "reject"]).describe("approve or reject"),
      },
    },
    async ({ safeTxHash, decision }) => {
      if (decision === "approve") await approve(safeTxHash, "mcp");
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, safeTxHash, decision }, null, 2) }],
      };
    }
  );

  const transports = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${MCP_PORT}`);

    if (url.pathname === "/mcp") {
      if (req.method === "POST") {
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
        await mcpServer.server.connect(transport);
        const sid = transport.sessionId;
        if (sid) transports.set(sid, transport);
        transport.onclose = () => { if (sid) transports.delete(sid); };
        await transport.handleRequest(req, res);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const sid = req.headers["mcp-session-id"];
        const t = sid ? transports.get(sid) : undefined;
        if (t) { await t.handleRequest(req, res); return; }
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "no such session" }));
        return;
      }
      res.writeHead(405).end();
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, safeAddress, chainId }));
      return;
    }

    res.writeHead(404).end("not found\n");
  });

  httpServer.listen(MCP_PORT, () => {
    console.log(`[input:mcp] Listening on http://127.0.0.1:${MCP_PORT}/mcp`);
    console.log(`[input:mcp] Health check: http://127.0.0.1:${MCP_PORT}/health`);
  });
}

// ── input mode: Dev CLI ───────────────────────────────────────────────────
async function startDevInput() {
  console.log("[input:dev] Fetching pending transactions…");
  const txs = await listPending();

  if (txs.length === 0) {
    console.log("[input:dev] No pending transactions found.");
    return;
  }

  console.log(`[input:dev] Found ${txs.length} pending transaction(s).\n`);

  for (const tx of txs) {
    console.log(JSON.stringify(summarize(tx), null, 2));

    const { decision } = await inquirer.prompt([
      {
        type: "list",
        name: "decision",
        message: `Decision for ${tx.safeTxHash.slice(0, 14)}…:`,
        choices: [
          { name: "Approve  →  add to Ledger queue", value: "approve" },
          { name: "Reject   →  no-op, stays pending", value: "reject" },
          { name: "Skip     →  decide later",          value: "skip"   },
        ],
      },
    ]);

    if (decision === "approve") {
      await approve(tx.safeTxHash, "dev");
      console.log(`  ✓ Approved — added to ledger-queue.json\n`);
    } else if (decision === "reject") {
      console.log(`  ✗ Rejected — tx stays pending\n`);
    } else {
      console.log(`  ↷ Skipped\n`);
    }
  }

  console.log("[input:dev] All transactions processed.");
}

// ── confirmation mode: Ledger UI ──────────────────────────────────────────
function startLedgerConfirm() {
  const app = express();

  app.use(express.static(join(__dirname, "ledger-ui")));

  app.get("/api/ledger-queue", async (_req, res) => {
    const q = await readJson(LEDGER_QUEUE, { items: [] });
    res.json(q);
  });

  app.delete("/api/ledger-queue/:hash", async (req, res) => {
    const q = await readJson(LEDGER_QUEUE, { items: [] });
    q.items = q.items.filter((i) => i.safeTxHash !== req.params.hash);
    await writeJson(LEDGER_QUEUE, q);
    res.json({ ok: true });
  });

  app.listen(LEDGER_PORT, () => {
    console.log(`[confirm:ledger] UI served at http://127.0.0.1:${LEDGER_PORT}`);
  });
}

// ── confirmation mode: Telegram ───────────────────────────────────────────
async function startTelegramConfirm() {
  const token  = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.ADMIN_TELEGRAM_CHAT_ID?.trim();

  if (!token || !chatId) {
    console.error(
      "Error: TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_CHAT_ID are required in .env for --telegram mode."
    );
    process.exit(1);
  }

  const bot = new TelegramBot(token, { polling: true });
  console.log("[confirm:telegram] Bot started, polling Safe for new transactions every 10 s…");

  const seenTxs = new Set();

  const poll = async () => {
    try {
      const txs = await listPending();
      for (const tx of txs) {
        if (seenTxs.has(tx.safeTxHash)) continue;
        seenTxs.add(tx.safeTxHash);

        const s = summarize(tx);
        const text =
          `*New pending Safe transaction*\n` +
          `Hash: \`${s.safeTxHash}\`\n` +
          `Nonce: ${s.nonce}\n` +
          `To: \`${s.to}\`\n` +
          `Value: ${s.value}\n` +
          (s.decodedMethod ? `Method: \`${s.decodedMethod}\`\n` : "") +
          `Submitted: ${s.submissionDate?.slice(0, 19) ?? "—"}\n` +
          `Confirmations: ${s.confirmationsCount}/${s.confirmationsRequired}`;

        bot.sendMessage(chatId, text, {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [[
              { text: "✅ Approve", callback_data: `approve:${tx.safeTxHash}` },
              { text: "❌ Reject",  callback_data: `reject:${tx.safeTxHash}`  },
            ]],
          },
        });
      }
    } catch (e) {
      console.error("[confirm:telegram] Poll error:", e.message);
    }
  };

  await poll();
  setInterval(poll, 10_000);

  bot.on("callback_query", async (query) => {
    const [action, safeTxHash] = (query.data ?? "").split(":");
    if (action !== "approve" && action !== "reject") return;

    try {
      if (action === "approve") {
        await approve(safeTxHash, "telegram");
        await bot.answerCallbackQuery(query.id, { text: "Approved — added to Ledger queue." });
        await bot.editMessageText(
          `✅ *Approved*\n\`${safeTxHash}\`\nAdded to Ledger queue.`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
        );
      } else {
        await bot.answerCallbackQuery(query.id, { text: "Rejected — tx stays pending." });
        await bot.editMessageText(
          `❌ *Rejected*\n\`${safeTxHash}\`\nTx stays pending on-chain.`,
          { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
        );
      }
    } catch (e) {
      await bot.answerCallbackQuery(query.id, { text: `Error: ${e.message}` });
    }
  });
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`Starting: input=${inputMode}  confirm=${confirmMode}`);

  // Start confirmation mode first so the queue endpoint is ready before any approvals land
  if (confirmMode === "ledger") {
    startLedgerConfirm();
  } else {
    await startTelegramConfirm();
  }

  // Start input mode
  if (inputMode === "mcp") {
    await startMcpInput();
  } else {
    await startDevInput();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
