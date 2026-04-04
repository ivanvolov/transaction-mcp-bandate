/**
 * Fetches the most recently submitted pending Safe multisig transaction (by submissionDate),
 * prints a summary, then optionally signs and submits the confirmation to the Transaction Service.
 *
 * Environment (repo-root `.env` or `safe_integration/.env`):
 *   SAFE_API_KEY   — required for api.safe.global (https://developer.safe.global)
 *   RPC_URL        — HTTP RPC for chainId (required only when you confirm signing)
 *   PRIVATE_KEY    — owner key, 0x-prefixed (required only when you confirm signing)
 *
 * To use "next executable" instead of newest proposal: sort by ascending nonce and take the first row.
 */

import dotenv from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import SafeApiKit from "@safe-global/api-kit";
import Safe from "@safe-global/protocol-kit";

import { config } from "./config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, "../.env") });
dotenv.config({ path: resolve(__dirname, ".env") });

const { safeAddress, chainId } = config;
const chainIdBn = BigInt(chainId);

function operationLabel(op) {
  if (op === 0) return "Call";
  if (op === 1) return "DelegateCall";
  return String(op);
}

function previewHex(hex, maxLen = 64) {
  if (!hex || hex === "0x") return "(empty)";
  const s = hex.startsWith("0x") ? hex : `0x${hex}`;
  if (s.length <= maxLen) return s;
  return `${s.slice(0, maxLen)}… (${s.length - 2} bytes)`;
}

function printTx(tx) {
  const confCount = tx.confirmations?.length ?? 0;
  const lines = [
    ["safeTxHash", tx.safeTxHash],
    ["nonce", tx.nonce],
    ["to", tx.to],
    ["value (wei)", tx.value],
    ["operation", operationLabel(tx.operation)],
    ["data", previewHex(tx.data ?? "0x", 66)],
    ["submissionDate", tx.submissionDate],
    ["proposer", tx.proposer ?? "—"],
    [
      "confirmations",
      `${confCount} / ${tx.confirmationsRequired} required`,
    ],
  ];
  if (tx.dataDecoded?.method) {
    lines.push(["decoded.method", tx.dataDecoded.method]);
  }
  const w = Math.max(...lines.map(([k]) => k.length));
  console.log("\n── Pending transaction ──\n");
  for (const [k, v] of lines) {
    console.log(`  ${k.padEnd(w)}  ${v}`);
  }
  console.log("");
}

async function main() {
  const apiKey = process.env.SAFE_API_KEY;
  if (!apiKey) {
    console.error(
      "Missing SAFE_API_KEY. Create a key at https://developer.safe.global and add it to .env",
    );
    process.exit(1);
  }

  const apiKit = new SafeApiKit({ chainId: chainIdBn, apiKey });

  const list = await apiKit.getPendingTransactions(safeAddress, { limit: 100 });
  const results = list.results ?? [];
  if (results.length === 0) {
    console.log("No pending multisig transactions for this Safe.");
    process.exit(0);
  }

  const sorted = [...results].sort(
    (a, b) =>
      new Date(b.submissionDate).getTime() -
      new Date(a.submissionDate).getTime(),
  );
  const tx = sorted[0];

  printTx(tx);

  const rl = createInterface({ input, output });
  const answer = await rl.question(
    "Sign and submit this confirmation? [y/N] ",
  );
  rl.close();

  const ok = /^y(es)?$/i.test(answer.trim());
  if (!ok) {
    console.log("Skipped signing.");
    process.exit(0);
  }

  const rpcUrl = process.env.RPC_URL;
  const privateKey = process.env.PRIVATE_KEY;
  if (!rpcUrl || !privateKey) {
    console.error(
      "Signing requires RPC_URL and PRIVATE_KEY in the environment.",
    );
    process.exit(1);
  }

  const protocolKit = await Safe.init({
    provider: rpcUrl,
    signer: privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`,
    safeAddress,
  });

  const signature = await protocolKit.signHash(tx.safeTxHash);

  try {
    await apiKit.confirmTransaction(tx.safeTxHash, signature.data);
    console.log("Confirmation submitted successfully.");
  } catch (e) {
    console.error("confirmTransaction failed:", e.message ?? e);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
