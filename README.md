# FlashPendle - PT/YT/SY Arbitrage Bot

Flash loan arbitrage bot for Pendle Protocol markets using the split-merge triangle strategy.

## Strategy

The bot exploits price inefficiencies between:
1. Direct PT ↔ SY swaps on Pendle markets
2. The mint/redeem coupling of PT+YT ↔ SY

Atomic arbitrage loop:
1. Flash loan underlying asset from Balancer
2. Convert to SY and mint PT+YT 
3. Sell PT for SY (when PT is overpriced)
4. Buy back PT with SY (at lower price)
5. Merge PT+YT back to SY
6. Convert to underlying, repay loan, keep profit

## Setup

### Prerequisites
- Node.js 18+
- Foundry
- Arbitrum RPC endpoint
- Private key with ETH for gas

### Installation

```bash
# Install dependencies
npm install

# Install Foundry dependencies
forge install
```

### Configuration

Create `.env` file:
```env
# RPC URLs
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
PRIVATE_KEY=your_private_key_here

# Contract addresses (Arbitrum)
BALANCER_VAULT=0xBA12222222228d8Ba445958a75a0704d566BF2C8
PENDLE_ROUTER_V4=0x888888888889758F76e7103c6CbF23ABbF58F946

# Bot parameters
MIN_PROFIT_BPS=15
MAX_FLASH_AMOUNT=1000000
POLLING_INTERVAL_MS=5000
```

### Deployment

```bash
# Compile contracts
forge build

# Deploy to Arbitrum
forge script script/deploy.s.sol --rpc-url arbitrum --broadcast

# Add deployed contract address to .env
echo "ARB_CONTRACT_ADDRESS=0x..." >> .env
```

### Running the Keeper Bot

```bash
# Run keeper
npm run keeper

# Development mode with auto-reload
npm run keeper:dev
```

## Architecture

### Smart Contract (`ArbPendleSplitMerge.sol`)
- Implements `IFlashLoanRecipient` for Balancer flash loans
- Executes atomic arbitrage within flash loan callback
- Owner-only execution for security
- Emergency token rescue function

### Keeper Bot (`src/keeper.ts`)
- Monitors Pendle markets via SDK
- Calculates arbitrage opportunities
- Simulates transactions before execution
- Executes profitable trades automatically

## Safety Features
- Minimum profit threshold (default 15 bps)
- Gas cost estimation and deduction
- Slippage protection via minUnderlyingOut
- Owner-only contract execution
- Market expiry checks

## Testing

```bash
# Run Foundry tests
forge test

# Run with verbosity
forge test -vvv
```

## Gas Optimization
- Batch approvals with max uint256
- Efficient swap routing via Pendle Router
- Minimal external calls
- Optimized for ~500k gas per arbitrage

## Risks
- Smart contract vulnerabilities
- Market manipulation/frontrunning
- Gas price spikes
- Pendle market illiquidity
- Flash loan availability

## License
MIT