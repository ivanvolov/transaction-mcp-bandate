#!/usr/bin/env node

import dotenv from "dotenv";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import yaml from "js-yaml";
import express from "express";
import inquirer from "inquirer";
import TelegramBot from "node-telegram-bot-api";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import SafeApiKit from "@safe-global/api-kit";

import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LEDGER_QUEUE  = join(__dirname, "ledger-queue.json");
const RULES_FILE    = join(__dirname, "rules.yml");
const DAILY_FILE    = join(__dirname, "daily-stats.json");

dotenv.config();

// ── arg parsing ───────────────────────────────────────────────────────────
const args = new Set(process.argv.slice(2));
const inputMode   = args.has("--mcp") ? "mcp" : args.has("--dev") ? "dev" : null;
const confirmMode = args.has("--ledger") ? "ledger" : args.has("--telegram") ? "telegram" : null;

if (!inputMode || !confirmMode) {
  console.error([
    "Usage: node index.mjs <--mcp | --dev> <--ledger | --telegram>",
    "",
    "Input mode (how transactions are decided):",
    "  --mcp        MCP server for AI agents (HTTP, Streamable HTTP transport)",
    "  --dev        Interactive CLI with arrow-key approve/reject",
    "",
    "Confirmation mode (how approved/rejected transactions are signed):",
    "  --ledger     Serve Ledger UI — connect hardware wallet and sign",
    "  --telegram   Send to Telegram bot for review and confirmation",
    "",
    "Examples:",
    "  node index.mjs --mcp --ledger",
    "  node index.mjs --dev --telegram",
  ].join("\n"));
  process.exit(1);
}

// ── config ────────────────────────────────────────────────────────────────
const MCP_PORT = Number(process.env.MCP_PORT) || 3847;

const { safeAddress, chainId } = config;
const chainIdBn = BigInt(chainId);

const apiKey = process.env.SAFE_API_KEY?.trim();
if (!apiKey) {
  console.error("Error: SAFE_API_KEY is missing. Add it to your .env file.");
  process.exit(1);
}
const apiKit = new SafeApiKit({ chainId: chainIdBn, apiKey });

const telegramToken  = process.env.TELEGRAM_BOT_TOKEN?.trim();
const telegramChatId = process.env.ADMIN_TELEGRAM_CHAT_ID?.trim();

if (confirmMode === "telegram" && (!telegramToken || !telegramChatId)) {
  console.error("Error: --telegram requires TELEGRAM_BOT_TOKEN and ADMIN_TELEGRAM_CHAT_ID in .env.");
  process.exit(1);
}

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
    safeTxHash:            tx.safeTxHash,
    nonce:                 tx.nonce,
    to:                    tx.to,
    value:                 tx.value,
    data:                  tx.data ? `${tx.data.slice(0, 66)}…` : null,
    operation:             tx.operation,
    submissionDate:        tx.submissionDate,
    confirmationsRequired: tx.confirmationsRequired,
    confirmationsCount:    tx.confirmations?.length ?? 0,
    proposer:              tx.proposer,
    decodedMethod:         tx.dataDecoded?.method ?? null,
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

async function appendQueue(tx, source, decision = "approve") {
  await mkdir(dirname(LEDGER_QUEUE), { recursive: true });
  const q = await readJson(LEDGER_QUEUE, { items: [] });
  if (q.items.some((i) => i.safeTxHash === tx.safeTxHash)) return;
  q.items.push({
    safeTxHash:     tx.safeTxHash,
    nonce:          tx.nonce,
    to:             tx.to,
    value:          tx.value,
    data:           tx.data ? `${tx.data.slice(0, 66)}…` : null,
    decodedMethod:  tx.dataDecoded?.method ?? null,
    submissionDate: tx.submissionDate,
    addedAt:        new Date().toISOString(),
    decision,
    source,
  });
  await writeJson(LEDGER_QUEUE, q);
}

async function approve(safeTxHash, source) {
  const tx = await apiKit.getTransaction(safeTxHash);
  if (!tx?.safeTxHash) throw new Error(`Tx not found: ${safeTxHash}`);
  await appendQueue(tx, source, "approve");
  await recordDailyApproval(tx.value ?? "0");
}

async function reject(safeTxHash, source, reason) {
  const tx = await apiKit.getTransaction(safeTxHash);
  if (!tx?.safeTxHash) throw new Error(`Tx not found: ${safeTxHash}`);
  await appendQueue(tx, source, "reject");
  console.log(`[queue] Rejection queued for Ledger signing: ${safeTxHash.slice(0, 14)}… (${reason ?? "no reason"})`);
}

// ── Rules engine ─────────────────────────────────────────────────────────
async function loadRules() {
  try {
    const raw = await readFile(RULES_FILE, "utf8");
    return yaml.load(raw) ?? {};
  } catch {
    return {};
  }
}

async function saveRules(rules) {
  await writeFile(RULES_FILE, yaml.dump(rules, { lineWidth: 120 }), "utf8");
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

async function loadDailyStats() {
  const stats = await readJson(DAILY_FILE, { date: null, totalValue: "0", txCount: 0 });
  if (stats.date !== todayKey()) {
    return { date: todayKey(), totalValue: "0", txCount: 0 };
  }
  return stats;
}

async function recordDailyApproval(value) {
  const stats = await loadDailyStats();
  stats.totalValue = String(BigInt(stats.totalValue) + BigInt(value || "0"));
  stats.txCount += 1;
  await writeJson(DAILY_FILE, stats);
}

/**
 * Evaluate a transaction against rules.yml.
 * Returns { action: "approve" | "reject" | "ask", reason: string, matchedRule: string }
 */
async function evaluateTransaction(tx) {
  const rules = await loadRules();
  const to = (tx.to ?? "").toLowerCase();
  const value = BigInt(tx.value ?? "0");
  const method = tx.dataDecoded?.method ?? null;

  // 1. Check daily caps first (hard limits)
  if (rules.daily_caps) {
    const stats = await loadDailyStats();
    const { max_total_value, max_tx_count } = rules.daily_caps;

    if (max_tx_count && stats.txCount >= max_tx_count) {
      return {
        action: "reject",
        reason: `Daily tx count limit reached (${stats.txCount}/${max_tx_count})`,
        matchedRule: "daily_caps.max_tx_count",
      };
    }

    if (max_total_value) {
      const cap = BigInt(max_total_value);
      const spent = BigInt(stats.totalValue);
      if (spent + value > cap) {
        return {
          action: "reject",
          reason: `Daily value cap exceeded (spent ${stats.totalValue} + tx ${tx.value} > cap ${max_total_value})`,
          matchedRule: "daily_caps.max_total_value",
        };
      }
    }
  }

  // 2. Check whitelisted addresses
  if (rules.whitelist) {
    for (const entry of rules.whitelist) {
      if (entry.address.toLowerCase() !== to) continue;

      if (entry.max_value_per_tx) {
        const maxVal = BigInt(entry.max_value_per_tx);
        if (value > maxVal) {
          return {
            action: "reject",
            reason: `Whitelisted "${entry.label}" but value ${tx.value} exceeds per-tx limit ${entry.max_value_per_tx}`,
            matchedRule: `whitelist[${entry.label}].max_value_per_tx`,
          };
        }
      }

      return {
        action: "approve",
        reason: `Whitelisted address: ${entry.label}`,
        matchedRule: `whitelist[${entry.label}]`,
      };
    }
  }

  // 3. Check known contracts
  if (rules.known_contracts) {
    for (const entry of rules.known_contracts) {
      if (entry.address.toLowerCase() !== to) continue;

      if (entry.max_value_per_tx) {
        const maxVal = BigInt(entry.max_value_per_tx);
        if (value > maxVal) {
          return {
            action: "reject",
            reason: `Known contract "${entry.label}" but native value ${tx.value} exceeds limit ${entry.max_value_per_tx}`,
            matchedRule: `known_contracts[${entry.label}].max_value_per_tx`,
          };
        }
      }

      if (method && entry.allowed_methods?.length) {
        if (entry.allowed_methods.includes(method)) {
          return {
            action: "approve",
            reason: `Known contract "${entry.label}", method "${method}" is allowed`,
            matchedRule: `known_contracts[${entry.label}].${method}`,
          };
        }
        return {
          action: "reject",
          reason: `Known contract "${entry.label}" but method "${method}" is NOT in allowed list [${entry.allowed_methods.join(", ")}]`,
          matchedRule: `known_contracts[${entry.label}].allowed_methods`,
        };
      }

      return {
        action: "approve",
        reason: `Known contract: ${entry.label} (no method restrictions)`,
        matchedRule: `known_contracts[${entry.label}]`,
      };
    }
  }

  // 4. Default action
  const defaultAction = rules.default_action ?? "ask";
  return {
    action: defaultAction,
    reason: `No rule matched for ${tx.to} — default: ${defaultAction}`,
    matchedRule: "default_action",
  };
}

// ── Telegram bot (only in --telegram mode) ───────────────────────────────
let bot = null;
if (confirmMode === "telegram") {
  bot = new TelegramBot(telegramToken, { polling: true });
  bot.on("polling_error", (err) => {
    console.error("[telegram] Polling error:", err.message);
  });
}

const hashLookup = new Map();
function shortKey(safeTxHash) {
  const key = safeTxHash.slice(2, 12);
  hashLookup.set(key, safeTxHash);
  return key;
}

function formatTxMessage(s) {
  return (
    `Hash: \`${s.safeTxHash}\`\n` +
    `Nonce: ${s.nonce}\n` +
    `To: \`${s.to}\`\n` +
    `Value: ${s.value}\n` +
    (s.decodedMethod ? `Method: \`${s.decodedMethod}\`\n` : "") +
    `Submitted: ${s.submissionDate?.slice(0, 19) ?? "—"}\n` +
    `Confirmations: ${s.confirmationsCount}/${s.confirmationsRequired}`
  );
}

async function sendRejectionToTelegram(safeTxHash, source, reason) {
  if (!bot) return;
  const tx = await apiKit.getTransaction(safeTxHash);
  if (!tx?.safeTxHash) return;
  const s = summarize(tx);
  const sk = shortKey(tx.safeTxHash);
  const reasonLine = reason ? `\nReason: _${reason}_` : "";
  const text = `⚠️ *Rejected by ${source}*${reasonLine}\n\n${formatTxMessage(s)}`;
  try {
    await bot.sendMessage(telegramChatId, text, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Override → approve", callback_data: `a:${sk}` },
          { text: "❌ Confirm reject",     callback_data: `r:${sk}` },
        ]],
      },
    });
    console.log(`[telegram] Rejection sent for review: ${safeTxHash.slice(0, 14)}…`);
  } catch (e) {
    console.error("[telegram] Send error:", e.message);
  }
}

if (bot) bot.on("callback_query", async (query) => {
  const [action, key] = (query.data ?? "").split(":");
  if (action !== "a" && action !== "r") return;

  const safeTxHash = hashLookup.get(key);
  if (!safeTxHash) {
    try { await bot.answerCallbackQuery(query.id, { text: "Session expired — restart the app." }); } catch {}
    return;
  }

  try {
    if (action === "a") {
      await approve(safeTxHash, "telegram-override");
      await bot.answerCallbackQuery(query.id, { text: "Approved — added to Ledger queue." });
      await bot.editMessageText(
        `✅ *Approved (overridden)*\n\`${safeTxHash}\`\nAdded to Ledger queue for signing.`,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
      );
    } else {
      await bot.answerCallbackQuery(query.id, { text: "Rejection confirmed." });
      await bot.editMessageText(
        `❌ *Rejection confirmed*\n\`${safeTxHash}\`\nTx stays pending on-chain.`,
        { chat_id: query.message.chat.id, message_id: query.message.message_id, parse_mode: "Markdown" }
      );
    }
  } catch (e) {
    try { await bot.answerCallbackQuery(query.id, { text: `Error: ${e.message}` }); } catch {}
  }
});

// ── Express server (UI + API + MCP on single port) ───────────────────────
function startServer() {
  const app = express();

  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
    if (_req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.use("/ui", express.static(join(__dirname, "ledger-ui")));

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

  app.use(express.json());

  app.get("/api/safe-tx/:hash", async (req, res) => {
    try {
      const tx = await apiKit.getTransaction(req.params.hash);
      if (!tx?.safeTxHash) return res.status(404).json({ error: "tx not found" });

      const typedData = {
        types: {
          EIP712Domain: [
            { name: "chainId", type: "uint256" },
            { name: "verifyingContract", type: "address" },
          ],
          SafeTx: [
            { name: "to", type: "address" },
            { name: "value", type: "uint256" },
            { name: "data", type: "bytes" },
            { name: "operation", type: "uint8" },
            { name: "safeTxGas", type: "uint256" },
            { name: "baseGas", type: "uint256" },
            { name: "gasPrice", type: "uint256" },
            { name: "gasToken", type: "address" },
            { name: "refundReceiver", type: "address" },
            { name: "nonce", type: "uint256" },
          ],
        },
        primaryType: "SafeTx",
        domain: { chainId, verifyingContract: safeAddress },
        message: {
          to: tx.to,
          value: tx.value,
          data: tx.data || "0x",
          operation: tx.operation,
          safeTxGas: tx.safeTxGas,
          baseGas: tx.baseGas,
          gasPrice: tx.gasPrice,
          gasToken: tx.gasToken,
          refundReceiver: tx.refundReceiver,
          nonce: tx.nonce,
        },
      };

      res.json({ tx: summarize(tx), typedData });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/safe-tx/:hash/confirm", async (req, res) => {
    try {
      const { signature } = req.body;
      if (!signature) return res.status(400).json({ error: "signature required" });

      await apiKit.confirmTransaction(req.params.hash, signature);

      const q = await readJson(LEDGER_QUEUE, { items: [] });
      q.items = q.items.filter((i) => i.safeTxHash !== req.params.hash);
      await writeJson(LEDGER_QUEUE, q);

      console.log(`[ledger] Confirmation submitted for ${req.params.hash.slice(0, 14)}…`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, safeAddress, chainId });
  });

  app.listen(MCP_PORT, () => {
    console.log(`[server] http://127.0.0.1:${MCP_PORT}`);
    console.log(`[server] Ledger UI: http://127.0.0.1:${MCP_PORT}/ui`);
  });

  return app;
}

// ── input mode: MCP ───────────────────────────────────────────────────────
async function startMcpInput(app) {
  const mcpServer = new McpServer({ name: "safe-agent", version: "1.0.0" });

  mcpServer.registerTool(
    "safe_list_pending",
    {
      description:
        `List unexecuted (pending) multisig transactions for Safe ${safeAddress} on chain ${chainId}. ` +
        `Each transaction includes a "rulesVerdict" from rules.yml showing whether it was auto-approved, auto-rejected, or needs your decision.`,
      inputSchema: {},
    },
    async () => {
      const txs = await listPending();
      const results = [];
      for (const tx of txs) {
        const verdict = await evaluateTransaction(tx);
        results.push({ ...summarize(tx), rulesVerdict: verdict });
      }
      const payload = { safeAddress, chainId, count: results.length, transactions: results };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }
  );

  mcpServer.registerTool(
    "safe_decide_transaction",
    {
      description:
        "Approve or reject a pending Safe tx. " +
        "Approve → added to Ledger queue for hardware signing. " +
        "Reject → sent to Telegram for human review. " +
        "Note: rules.yml may have already auto-decided this tx.",
      inputSchema: {
        safeTxHash: z.string().describe("0x-prefixed Safe tx hash"),
        decision:   z.enum(["approve", "reject"]).describe("approve or reject"),
        reason:     z.string().optional().describe("Why this decision was made"),
      },
    },
    async ({ safeTxHash, decision, reason }) => {
      if (decision === "approve") {
        await approve(safeTxHash, "mcp");
      } else if (confirmMode === "telegram") {
        await sendRejectionToTelegram(safeTxHash, "agent", reason);
      } else {
        await reject(safeTxHash, "mcp", reason);
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, safeTxHash, decision }, null, 2) }],
      };
    }
  );

  mcpServer.registerTool(
    "safe_get_rules",
    {
      description: "Read the current firewall rules (rules.yml). Returns the YAML content and parsed JSON.",
      inputSchema: {},
    },
    async () => {
      const rules = await loadRules();
      const raw = await readFile(RULES_FILE, "utf8").catch(() => "# empty");
      return { content: [{ type: "text", text: JSON.stringify({ rules, raw_yaml: raw }, null, 2) }] };
    }
  );

  mcpServer.registerTool(
    "safe_update_rules",
    {
      description:
        "Update the firewall rules. Pass the full YAML content. " +
        "Supports: whitelist (addresses + per-tx limits), known_contracts (address + allowed_methods), " +
        "daily_caps (max_total_value, max_tx_count), default_action (ask/reject).",
      inputSchema: {
        yaml_content: z.string().describe("Full YAML content to write to rules.yml"),
      },
    },
    async ({ yaml_content }) => {
      try {
        yaml.load(yaml_content);
      } catch (e) {
        return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: `Invalid YAML: ${e.message}` }) }] };
      }
      await writeFile(RULES_FILE, yaml_content, "utf8");
      const rules = await loadRules();
      return { content: [{ type: "text", text: JSON.stringify({ ok: true, rules }, null, 2) }] };
    }
  );

  const transports = new Map();

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await mcpServer.server.connect(transport);
    const sid = transport.sessionId;
    if (sid) transports.set(sid, transport);
    transport.onclose = () => { if (sid) transports.delete(sid); };
    await transport.handleRequest(req, res);
  });

  app.get("/mcp", async (req, res) => {
    const sid = req.headers["mcp-session-id"];
    const t = sid ? transports.get(sid) : undefined;
    if (t) return t.handleRequest(req, res);
    res.status(400).json({ error: "no such session" });
  });

  app.delete("/mcp", async (req, res) => {
    const sid = req.headers["mcp-session-id"];
    const t = sid ? transports.get(sid) : undefined;
    if (t) return t.handleRequest(req, res);
    res.status(400).json({ error: "no such session" });
  });

  console.log(`[mcp] MCP endpoint: http://127.0.0.1:${MCP_PORT}/mcp`);
}

// ── input mode: Dev CLI ───────────────────────────────────────────────────
async function startDevInput() {
  while (true) {
    console.log("[dev] Fetching pending transactions…");
    const txs = await listPending();

    if (txs.length === 0) {
      console.log("[dev] No pending transactions found.");
    } else {
      console.log(`[dev] Found ${txs.length} pending transaction(s).\n`);

      for (const tx of txs) {
        const verdict = await evaluateTransaction(tx);
        const s = summarize(tx);

        console.log(JSON.stringify(s, null, 2));
        console.log(`  Rules verdict: ${verdict.action.toUpperCase()} — ${verdict.reason}`);
        console.log(`  Matched rule:  ${verdict.matchedRule}\n`);

        if (verdict.action === "approve") {
          await approve(tx.safeTxHash, `rules:${verdict.matchedRule}`);
          console.log(`  ✓ Auto-approved by rules — added to ledger-queue.json\n`);
          continue;
        }

        if (verdict.action === "reject") {
          if (confirmMode === "telegram") {
            await sendRejectionToTelegram(tx.safeTxHash, "rules", verdict.reason);
            console.log(`  ✗ Auto-rejected by rules — sent to Telegram\n`);
          } else {
            await reject(tx.safeTxHash, `rules:${verdict.matchedRule}`, verdict.reason);
            console.log(`  ✗ Auto-rejected by rules — rejection queued for Ledger signing\n`);
          }
          continue;
        }

        const { decision } = await inquirer.prompt([
          {
            type: "list",
            name: "decision",
            message: `Decision for ${tx.safeTxHash.slice(0, 14)}…:`,
            choices: [
              { name: "Approve  →  Ledger queue for signing",    value: "approve" },
              { name: confirmMode === "ledger"
                        ? "Reject   →  sign rejection tx via Ledger"
                        : "Reject   →  send to Telegram for review",
                value: "reject" },
              { name: "Skip     →  decide later",                value: "skip"    },
            ],
          },
        ]);

        if (decision === "approve") {
          await approve(tx.safeTxHash, "dev");
          console.log(`  ✓ Approved — added to ledger-queue.json\n`);
        } else if (decision === "reject") {
          if (confirmMode === "telegram") {
            await sendRejectionToTelegram(tx.safeTxHash, "dev");
            console.log(`  ✗ Rejected — sent to Telegram for review\n`);
          } else {
            await reject(tx.safeTxHash, "dev");
            console.log(`  ✗ Rejected — queued for Ledger signing\n`);
          }
        } else {
          console.log(`  ↷ Skipped\n`);
        }
      }
    }

    const { next } = await inquirer.prompt([
      {
        type: "list",
        name: "next",
        message: "What next?",
        choices: [
          { name: "Refresh  →  check for new transactions", value: "refresh" },
          { name: "Exit     →  stop the app",               value: "exit"    },
        ],
      },
    ]);

    if (next === "exit") {
      console.log("[dev] Bye.");
      process.exit(0);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────
async function main() {
  const rules = await loadRules();
  const wlCount = rules.whitelist?.length ?? 0;
  const kcCount = rules.known_contracts?.length ?? 0;

  console.log(`Starting: input=${inputMode}, confirm=${confirmMode}`);
  console.log(`  Rules loaded: ${wlCount} whitelisted, ${kcCount} known contracts`);
  console.log(`  Daily caps: ${rules.daily_caps?.max_total_value ?? "none"} value, ${rules.daily_caps?.max_tx_count ?? "none"} txs`);
  console.log(`  Default: ${rules.default_action ?? "ask"}`);

  if (confirmMode === "ledger") {
    console.log(`  Approve → Ledger queue → sign at http://127.0.0.1:${MCP_PORT}/ui`);
    console.log(`  Reject  → Ledger queue → sign rejection tx at http://127.0.0.1:${MCP_PORT}/ui\n`);
  } else {
    console.log(`  Approve → Ledger queue → Telegram override available`);
    console.log(`  Reject  → Telegram bot for human review\n`);
  }

  // Express server is always started (serves API + MCP endpoint; Ledger UI only relevant in --ledger mode)
  const app = startServer();

  if (inputMode === "mcp") {
    await startMcpInput(app);
  } else {
    await startDevInput();
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
