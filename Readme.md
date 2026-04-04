# Ledger Transaction Proposer via MCP

This project provides a script to craft and propose transactions to a **Ledger** hardware device using a Model Context Protocol (MCP) server.

## Features
- **Transaction Crafting**: Uses `ethers.js` to create and serialize unsigned Ethereum transactions.
- **MCP Ledger Integration**: Demonstrates how to connect to an MCP server (like `mcp-ledger`) to sign transactions with a hardware device.
- **TypeScript Ready**: Built with TypeScript for modern development.

## Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/ivanvolov/transaction-mcp-bandate.git
   cd transaction-mcp-bandate
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

## Testing the Ledger Workflow

To test the workflow of proposing a transaction to your Ledger device, follow these steps:

### 1. Prerequisites
- **A Ledger Device**: Connected to your computer and the Ethereum app opened.
- **An MCP Ledger Server**: You should have the `mcp-ledger` server installed and built on your machine.
- **Node.js**: Installed on your system.

### 2. Configure the Test Script
Open `src/index.ts` and locate the `test()` function at the bottom. Uncomment it and update the following:
- **RPC URL**: Provide a valid Ethereum RPC URL (e.g., from Alchemy or Infura).
- **MCP Server Path**: Update the `proposeToLedger` call with the actual path to your `mcp-ledger/dist/index.js` file.

### 3. Run the Test
You can run the script using `npm run dev`:
```bash
npm run dev
```

### What Happens During the Test?
1. **Crafting**: The script creates a simple transfer of 0.001 ETH to the zero address and serializes it as an unsigned transaction hex string.
2. **Connecting**: It starts the `mcp-ledger` server as a child process using the MCP SDK.
3. **Proposing**: It calls the `sign_transaction` tool on the MCP server, passing the unsigned transaction hex.
4. **Signing**: Your Ledger device will prompt you to review and sign the transaction.
5. **Result**: Once signed, the script will log the signed transaction components (v, r, s) returned by the Ledger.

### Code Example
```typescript
import LedgerTransactionProposer from './src/index.js';

const proposer = new LedgerTransactionProposer("https://eth-mainnet.public.blastapi.io");

// 1. Craft an unsigned transaction hex
const unsignedTx = await proposer.craftTransaction(
  "0x0000000000000000000000000000000000000000", // Recipient
  "0.001" // Value in ETH
);

// 2. Propose to Ledger via MCP server
await proposer.proposeToLedger(
  "node", 
  ["/absolute/path/to/mcp-ledger/dist/index.js"], 
  unsignedTx
);
```

## Development
To build the project:
```bash
npm run build
```
