import { LedgerEIP1193Provider } from "@ledgerhq/ledger-wallet-provider";
import SafeApiKit from "@safe-global/api-kit";
import Safe from "@safe-global/protocol-kit";
import { ethers } from "ethers";

// ── Config ──────────────────────────────────────────────────────────────
const SAFE_ADDRESS = "0xe4522AcE60ccE4658751024310FF04f84daf8149";
const CHAIN_ID = 42161; // Arbitrum One
const USDC_ADDRESS = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"; // Native USDC on Arbitrum
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const USDC_DECIMALS = 6;
const AMOUNT = 1; // 1 USDC

// ERC-20 transfer(address,uint256) selector + encoding
const TRANSFER_SELECTOR = "0xa9059cbb";
function encodeTransferData(to, amount) {
  const toParam = to.slice(2).padStart(64, "0");
  const amountParam = BigInt(amount * 10 ** USDC_DECIMALS)
    .toString(16)
    .padStart(64, "0");
  return TRANSFER_SELECTOR + toParam + amountParam;
}

// ── DOM refs ────────────────────────────────────────────────────────────
const $log = document.getElementById("log");
const $btnConnect = document.getElementById("btnConnect");
const $btnPropose = document.getElementById("btnPropose");
const $statusDot = document.getElementById("statusDot");
const $accountInfo = document.getElementById("accountInfo");
const $account = document.getElementById("account");
const $chainId = document.getElementById("chainId");
const $safeAddr = document.getElementById("safeAddr");
const $usdcAddr = document.getElementById("usdcAddr");

// Show static info
$safeAddr.textContent = SAFE_ADDRESS;
$usdcAddr.textContent = USDC_ADDRESS;

function log(msg) {
  const ts = new Date().toLocaleTimeString();
  $log.textContent += `[${ts}] ${msg}\n`;
  $log.scrollTop = $log.scrollHeight;
  console.log(msg);
}

// ── Ledger provider state ───────────────────────────────────────────────
let provider = null;
let signerAddress = null;

$btnConnect.addEventListener("click", async () => {
  try {
    $btnConnect.disabled = true;
    $btnConnect.textContent = "Connecting…";
    log("Initializing Ledger provider…");

    // Initialize the Ledger EIP-1193 provider
    provider = new LedgerEIP1193Provider();

    // Request accounts — this triggers the Ledger connection flow
    const accounts = await provider.request({
      method: "eth_requestAccounts",
      params: [],
    });

    signerAddress = accounts[0];
    if (!signerAddress) throw new Error("No account returned from Ledger");

    const chainIdHex = await provider.request({
      method: "eth_chainId",
      params: [],
    });

    // Update UI
    $account.textContent = signerAddress;
    $chainId.textContent = `${parseInt(chainIdHex, 16)} (${chainIdHex})`;
    $accountInfo.style.display = "block";
    $statusDot.className = "status connected";
    $btnConnect.textContent = "Connected";
    $btnPropose.disabled = false;

    log(`Connected: ${signerAddress}`);

    // Listen for events
    provider.on("accountsChanged", (accs) => {
      signerAddress = accs[0] || null;
      $account.textContent = signerAddress ?? "—";
      log(`Account changed: ${signerAddress}`);
    });

    provider.on("disconnect", () => {
      log("Ledger disconnected");
      signerAddress = null;
      $statusDot.className = "status disconnected";
      $btnConnect.textContent = "Connect Ledger";
      $btnConnect.disabled = false;
      $btnPropose.disabled = true;
      $accountInfo.style.display = "none";
    });
  } catch (err) {
    log(`Connection error: ${err.message}`);
    $btnConnect.textContent = "Connect Ledger";
    $btnConnect.disabled = false;
  }
});

// ── Propose & Sign ──────────────────────────────────────────────────────
$btnPropose.addEventListener("click", async () => {
  if (!provider || !signerAddress) return;

  try {
    $btnPropose.disabled = true;
    $btnPropose.textContent = "Preparing transaction…";

    const transferData = encodeTransferData(ZERO_ADDRESS, AMOUNT);
    log(`Encoded USDC transfer: ${transferData.slice(0, 20)}…`);

    // ── Build Safe transaction ──────────────────────────────────────
    log("Initializing Safe Protocol Kit…");

    // Use the Ledger EIP-1193 provider as the signer
    const protocolKit = await Safe.init({
      provider,
      signer: signerAddress,
      safeAddress: SAFE_ADDRESS,
    });

    const safeTransaction = await protocolKit.createTransaction({
      transactions: [
        {
          to: USDC_ADDRESS,
          data: transferData,
          value: "0",
          operation: 0, // Call
        },
      ],
    });

    log("Safe transaction created. Requesting Ledger signature…");
    $btnPropose.textContent = "Please confirm on Ledger…";

    // Sign the transaction hash with Ledger
    const safeTxHash = await protocolKit.getTransactionHash(safeTransaction);
    log(`safeTxHash: ${safeTxHash}`);

    const signature = await protocolKit.signHash(safeTxHash);
    log(`Signature obtained: ${signature.data.slice(0, 20)}…`);

    // ── Submit proposal to Safe Transaction Service ─────────────────
    log("Submitting proposal to Safe Transaction Service…");
    $btnPropose.textContent = "Submitting proposal…";

    const apiKit = new SafeApiKit({ chainId: BigInt(CHAIN_ID) });

    await apiKit.proposeTransaction({
      safeAddress: SAFE_ADDRESS,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: signerAddress,
      senderSignature: signature.data,
    });

    log("Transaction proposed successfully!");
    log(`View at: https://app.safe.global/transactions/queue?safe=arb1:${SAFE_ADDRESS}`);

    $btnPropose.textContent = "Proposed! ✓";
    setTimeout(() => {
      $btnPropose.textContent = "Propose & Sign with Ledger";
      $btnPropose.disabled = false;
    }, 3000);
  } catch (err) {
    log(`Error: ${err.message}`);
    $btnPropose.textContent = "Propose & Sign with Ledger";
    $btnPropose.disabled = false;
  }
});
