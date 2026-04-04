# Safe & Ledger MCP Transaction Proposer

This project provides a script to propose transactions to a **Safe (formerly Gnosis Safe)** wallet and optionally sign them using a **Ledger** device via a Model Context Protocol (MCP) server.

## Features
- **Safe Wallet Integration**: Uses `@safe-global/protocol-kit` and `@safe-global/api-kit` to propose transactions to the Safe Transaction Service.
- **MCP Ledger Support**: Includes an example of how to connect to an MCP server (like `mcp-ledger`) to sign transactions with a hardware device.
- **TypeScript Ready**: Built with TypeScript for type safety and modern development.

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

3. **Configure environment variables**:
   Create a `.env` file with the following:
   ```env
   RPC_URL=https://eth-mainnet.g.alchemy.com/v2/your-api-key
   SIGNER_PRIVATE_KEY=0xYourSafeOwnerPrivateKey
   ```

## Usage

The main logic is in `src/index.ts`. You can use the `SafeTransactionProposalClient` class to connect to a Safe and propose transactions.

### Propose a Transaction
```typescript
import SafeTransactionProposalClient from './src/index.js';

const client = new SafeTransactionProposalClient(
  "https://eth-mainnet.g.alchemy.com/v2/your-api-key",
  1n, // Mainnet
  "https://safe-transaction-mainnet.safe.global"
);

await client.connectSafe("0xYourSafeAddress");

// Propose a 0.01 ETH transfer
await client.proposeTransaction(
  "0xRecipientAddress",
  ethers.parseEther("0.01").toString(),
  "0x",
  process.env.SIGNER_PRIVATE_KEY
);
```

### Sign with Ledger via MCP
If you have an MCP server like `mcp-ledger` running, you can call it to sign:
```typescript
await client.signWithLedgerMCP(
  "node", 
  ["path/to/mcp-ledger/dist/index.js"], 
  "0xRawTransactionData"
);
```

## Development
To run in development mode:
```bash
npm run dev
```

To build:
```bash
npm run build
```
