#!/usr/bin/env node
/**
 * Safe MCP server — two tools, two modes, HTTP transport (ngrok-friendly).
 *
 * Tools:
 *   safe_list_pending        — list unexecuted multisig txs for the configured Safe
 *   safe_decide_transaction  — approve (→ Ledger queue) or reject (no-op, stays in list)
 *
 * Modes:
 *   normal (default)  — trusts the caller's decision argument
 *   dev (--dev)       — prompts the human on /dev/tty before each decide (y/N)
 *
 * Usage:
 *   node mcp/safeMcp.mjs              # http on MCP_PORT (default 3847)
 *   node mcp/safeMcp.mjs --dev        # same + console approval on /dev/tty
 *   ngrok http 3847                   # expose to internet
 *
 * Env (.env in safe_integration/ or repo root):
 *   SAFE_API_KEY  — required
 *   MCP_PORT      — default 3847
 */

import dotenv from "dotenv";
import http from "node:http";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import SafeApiKit from "@safe-global/api-kit";

import { config } from "../config.mjs";

// ── paths ───────────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const SAFE_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(SAFE_ROOT, "..");
const LEDGER_QUEUE = join(REPO_ROOT, "agent/ledger-queue.json");

// ── env ─────────────────────────────────────────────────────────────────
dotenv.config({ path: join(REPO_ROOT, ".env") });
dotenv.config({ path: join(SAFE_ROOT, ".env") });

const isDev = process.argv.includes("--dev") || process.env.MCP_DEV === "1";
const PORT = Number(process.env.MCP_PORT) || 3847;
const { safeAddress, chainId } = config;
const chainIdBn = BigInt(chainId);

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

async function listPending(apiKit) {
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

async function devPrompt(safeTxHash, agentDecision) {
  const input = createReadStream("/dev/tty");
  const output = createWriteStream("/dev/tty");
  const rl = readline.createInterface({ input, output });
  try {
    const ans = await rl.question(
      `\n[dev] safeTxHash: ${safeTxHash}\n` +
        `      agent says: ${agentDecision}\n` +
        `      Approve? [y/N]: `,
    );
    return /^y(es)?$/i.test(ans.trim());
  } finally {
    rl.close();
  }
}

// ── main ────────────────────────────────────────────────────────────────
async function main() {
  const apiKey = process.env.SAFE_API_KEY?.trim();
  if (!apiKey) {
    console.error("[safe-mcp] SAFE_API_KEY missing in .env");
    process.exit(1);
  }
  const apiKit = new SafeApiKit({ chainId: chainIdBn, apiKey });

  if (isDev) {
    console.error("[safe-mcp] DEV mode — decide will prompt on /dev/tty");
  }

  const mcpServer = new McpServer({ name: "safe-agent", version: "1.0.0" });

  // ── tool 1: list ────────────────────────────────────────────────────
  mcpServer.registerTool(
    "safe_list_pending",
    {
      description:
        `List unexecuted (pending) multisig transactions. ` +
        `Safe ${safeAddress}, chain ${chainId}.`,
      inputSchema: {},
    },
    async () => {
      const txs = await listPending(apiKit);
      const payload = {
        safeAddress,
        chainId,
        count: txs.length,
        transactions: txs.map(summarize),
      };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  // ── tool 2: decide ──────────────────────────────────────────────────
  mcpServer.registerTool(
    "safe_decide_transaction",
    {
      description:
        "Approve or reject a pending Safe tx. " +
        "Approve → added to Ledger web queue for signing. " +
        "Reject → no-op; tx stays pending and will appear in list_pending next time. " +
        (isDev
          ? "DEV: prompts the operator on the terminal regardless of decision arg."
          : "Normal: uses the decision argument directly."),
      inputSchema: {
        safeTxHash: z.string().describe("0x-prefixed Safe tx hash"),
        decision: z.enum(["approve", "reject"]).describe("approve or reject"),
      },
    },
    async ({ safeTxHash, decision }) => {
      let final = decision;

      if (isDev) {
        const ok = await devPrompt(safeTxHash, decision);
        final = ok ? "approve" : "reject";
        console.error(`[safe-mcp] dev resolved → ${final}`);
      }

      if (final === "approve") {
        const tx = await apiKit.getTransaction(safeTxHash);
        if (!tx?.safeTxHash) throw new Error(`Tx not found: ${safeTxHash}`);
        await appendQueue(tx, isDev ? "mcp_dev" : "mcp");
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ ok: true, safeTxHash, decision: final, dev: isDev }, null, 2),
          },
        ],
      };
    },
  );

  // ── HTTP transport ──────────────────────────────────────────────────
  const transports = new Map();

  const httpServer = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);

    if (url.pathname === "/mcp") {
      if (req.method === "POST") {
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });
        await mcpServer.server.connect(transport);
        const sid = transport.sessionId;
        if (sid) transports.set(sid, transport);
        transport.onclose = () => {
          if (sid) transports.delete(sid);
        };
        await transport.handleRequest(req, res);
        return;
      }
      if (req.method === "GET" || req.method === "DELETE") {
        const sid = req.headers["mcp-session-id"];
        const t = sid ? transports.get(sid) : undefined;
        if (t) {
          await t.handleRequest(req, res);
          return;
        }
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

  httpServer.listen(PORT, () => {
    console.error(`[safe-mcp] listening on http://127.0.0.1:${PORT}/mcp`);
    console.error(`[safe-mcp] ngrok http ${PORT}  →  then use <ngrok-url>/mcp`);
  });
}

main().catch((e) => {
  console.error("[safe-mcp] fatal:", e);
  process.exit(1);
});
