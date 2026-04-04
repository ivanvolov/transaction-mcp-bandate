import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ethers } from "ethers";
import dotenv from "dotenv";

dotenv.config();

/**
 * LedgerTransactionProposer
 * 
 * This script focuses on proposing transactions to a Ledger device via an MCP server.
 */
class LedgerTransactionProposer {
  private rpcUrl: string;

  constructor(rpcUrl: string) {
    this.rpcUrl = rpcUrl;
  }

  /**
   * Craft a raw transaction for signing.
   */
  async craftTransaction(to: string, value: string, data: string = "0x") {
    const provider = new ethers.JsonRpcProvider(this.rpcUrl);
    
    // For a real transaction, we'd need to fetch nonce and gas parameters
    // This is a simplified example for crafting a transaction object
    const tx = {
      to,
      value: ethers.parseEther(value),
      data,
      chainId: (await provider.getNetwork()).chainId,
      nonce: 0, // In a real scenario, fetch this from provider.getTransactionCount(from)
      gasLimit: 21000,
      maxFeePerGas: ethers.parseUnits("20", "gwei"),
      maxPriorityFeePerGas: ethers.parseUnits("1", "gwei"),
      type: 2 // EIP-1559
    };

    return ethers.Transaction.from(tx).unsignedSerialized;
  }

  /**
   * Proposes a transaction to a Ledger device via an MCP server.
   * 
   * @param mcpServerCommand The command to start the MCP server (e.g., 'node')
   * @param mcpServerArgs Arguments for the command (e.g., ['path/to/mcp-ledger/dist/index.js'])
   * @param unsignedTx The unsigned serialized transaction hex string
   */
  async proposeToLedger(mcpServerCommand: string, mcpServerArgs: string[], unsignedTx: string) {
    console.log("Connecting to Ledger MCP server...");
    
    const transport = new StdioClientTransport({
      command: mcpServerCommand,
      args: mcpServerArgs,
    });

    const client = new Client(
      { name: "ledger-proposer-client", version: "1.0.0" },
      { capabilities: {} }
    );

    try {
      await client.connect(transport);
      console.log("Connected to Ledger MCP server.");

      console.log("Sending transaction to Ledger for signing...");
      // Using the 'sign_transaction' tool from the mcp-ledger server
      const result = await client.callTool({
        name: "sign_transaction",
        arguments: {
          transactionData: unsignedTx,
          derivationPath: "44'/60'/0'/0/0" // Standard Ethereum derivation path
        }
      });

      console.log("Ledger Response:", JSON.stringify(result, null, 2));
      return result;
    } catch (error) {
      console.error("Error during Ledger proposal:", error);
      throw error;
    } finally {
      // Close transport if needed (SDK handles most cleanup)
    }
  }
}

// Example for local testing
/*
async function test() {
  const proposer = new LedgerTransactionProposer("https://eth-mainnet.public.blastapi.io");
  
  // 1. Craft an unsigned transaction
  const unsignedTx = await proposer.craftTransaction(
    "0x0000000000000000000000000000000000000000", // Recipient
    "0.001" // Value in ETH
  );
  
  console.log("Unsigned Transaction Hex:", unsignedTx);

  // 2. Propose to Ledger (Update paths to your local mcp-ledger installation)
  // await proposer.proposeToLedger(
  //   "node", 
  //   ["/path/to/mcp-ledger/dist/index.js"], 
  //   unsignedTx
  // );
}

test().catch(console.error);
*/

export default LedgerTransactionProposer;
