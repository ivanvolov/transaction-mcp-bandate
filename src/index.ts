import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ethers } from "ethers";
import Safe, { SafeFactory, SafeAccountConfig } from "@safe-global/protocol-kit";
import SafeApiKit from "@safe-global/api-kit";
import { MetaTransactionData, SafeTransactionDataPartial } from "@safe-global/safe-core-sdk-types";
import dotenv from "dotenv";

dotenv.config();

/**
 * SafeTransactionProposalClient
 * 
 * This script demonstrates how to:
 * 1. Propose a transaction to a Safe wallet.
 * 2. Optionally use an MCP server (like mcp-ledger) to sign the transaction.
 */
class SafeTransactionProposalClient {
  private safeApiKit: SafeApiKit;
  private protocolKit: Safe | null = null;
  private rpcUrl: string;
  private chainId: bigint;

  constructor(rpcUrl: string, chainId: bigint, txServiceUrl: string) {
    this.rpcUrl = rpcUrl;
    this.chainId = chainId;
    this.safeApiKit = new SafeApiKit({
      chainId: chainId,
      txServiceUrl: txServiceUrl
    });
  }

  /**
   * Connects to a Safe wallet.
   */
  async connectSafe(safeAddress: string, signer?: any) {
    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    const signerOrProvider = signer ? new ethers.Wallet(signer, provider) : provider;
    this.protocolKit = await Safe.init({
      provider: this.rpcUrl,
      safeAddress: safeAddress
    });
    console.log(`Connected to Safe at ${safeAddress}`);
  }

  /**
   * Proposes a transaction to the Safe Transaction Service.
   */
  async proposeTransaction(to: string, value: string, data: string, signer: any) {
    if (!this.protocolKit) throw new Error("Safe not connected");

    const safeTransactionData: SafeTransactionDataPartial = {
      to,
      value,
      data,
    };

    // Re-initialize protocolKit with a signer to sign the transaction
    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    const wallet = new ethers.Wallet(signer, provider);
    this.protocolKit = await this.protocolKit.connect({ provider: provider, signer: wallet });

    const safeTransaction = await this.protocolKit.createTransaction({ 
        transactions: [safeTransactionData]
    });

    const safeTxHash = await this.protocolKit.getTransactionHash(safeTransaction);
    const senderSignature = await this.protocolKit.signHash(safeTxHash);

    const safeAddress = await this.protocolKit.getAddress();

    await this.safeApiKit.proposeTransaction({
      safeAddress,
      safeTransactionData: safeTransaction.data,
      safeTxHash,
      senderAddress: await wallet.getAddress(),
      senderSignature: senderSignature.data,
    });

    console.log(`Transaction proposed! Hash: ${safeTxHash}`);
    return safeTxHash;
  }

  /**
   * Example of calling an MCP server to sign a transaction with a Ledger device.
   */
  async signWithLedgerMCP(mcpServerCommand: string, mcpServerArgs: string[], transactionData: string) {
    console.log("Connecting to Ledger MCP server...");
    const transport = new StdioClientTransport({
      command: mcpServerCommand,
      args: mcpServerArgs,
    });

    const client = new Client(
      { name: "safe-ledger-client", version: "1.0.0" },
      { capabilities: {} }
    );

    await client.connect(transport);
    console.log("Connected to Ledger MCP server.");

    // Assuming the MCP server has a 'sign_transaction' tool
    const result = await client.callTool({
      name: "sign_transaction",
      arguments: {
        transactionData: transactionData,
        derivationPath: "44'/60'/0'/0/0" // Default Ledger path
      }
    });

    console.log("Ledger signature result:", result);
    return result;
  }
}

// Example usage (uncomment and fill details to run)
/*
async function main() {
  const client = new SafeTransactionProposalClient(
    process.env.RPC_URL || "https://eth-mainnet.g.alchemy.com/v2/your-api-key",
    1n, // Mainnet
    "https://safe-transaction-mainnet.safe.global"
  );

  const safeAddress = "0xYourSafeAddress";
  // A signer is needed to propose a transaction. This should be one of the Safe owners.
  const signerPrivateKey = process.env.SIGNER_PRIVATE_KEY;
  if (!signerPrivateKey) {
      throw new Error("SIGNER_PRIVATE_KEY environment variable not set.");
  }

  await client.connectSafe(safeAddress);

  // Propose a simple transfer
  await client.proposeTransaction(
    "0xRecipientAddress",
    ethers.parseEther("0.01").toString(),
    "0x",
    signerPrivateKey
  );

  // If you want to sign with Ledger via MCP:
  // const rawTx = "0xYourRawTxData";
  // await client.signWithLedgerMCP("node", ["path/to/mcp-ledger/dist/index.js"], rawTx);
}

main().catch(console.error);
*/

export default SafeTransactionProposalClient;
