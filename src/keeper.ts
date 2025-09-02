import { ethers } from 'ethers';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

// Configuration
const config = {
  rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
  privateKey: process.env.PRIVATE_KEY!,
  balancerVault: process.env.BALANCER_VAULT || '0xBA12222222228d8Ba445958a75a0704d566BF2C8',
  pendleRouter: process.env.PENDLE_ROUTER_V4 || '0x888888888889758F76e7103c6CbF23ABbF58F946',
  minProfitBps: parseInt(process.env.MIN_PROFIT_BPS || '15'),
  maxFlashAmount: ethers.parseEther(process.env.MAX_FLASH_AMOUNT || '1000000'),
  pollingInterval: parseInt(process.env.POLLING_INTERVAL_MS || '5000'),
  arbContractAddress: process.env.ARB_CONTRACT_ADDRESS || '',
};

// ABI for our arbitrage contract
const ARB_CONTRACT_ABI = [
  'function executeArb(tuple(address vault, address router, address underlying, address yt, address market, uint256 flashAmount, uint256 pyToCycle, uint256 minUnderlyingOut) params)',
  'function owner() view returns (address)',
];

// Pendle market ABI for reading state
const MARKET_ABI = [
  'function readState(address router) view returns (uint256 totalPt, uint256 totalSy, uint256 totalLp, uint256 lastLnImpliedRate)',
  'function readTokens() view returns (address _SY, address _PT, address _YT)',
  'function activeBalance(address token) view returns (uint256)',
];

// YT contract ABI
const YT_ABI = [
  'function PT() view returns (address)',
  'function SY() view returns (address)',
  'function isExpired() view returns (bool)',
  'function pyIndexCurrent() returns (uint256)',
];

interface MarketData {
  address: string;
  name: string;
  yt: { address: string };
  pt: { address: string };
  sy: { address: string };
  underlyingAsset: { address: string };
  liquidity: { usd: number };
  isExpired: boolean;
}

interface ArbOpportunity {
  market: string;
  yt: string;
  pt: string;
  sy: string;
  underlying: string;
  profitBps: number;
  optimalSize: bigint;
  expectedProfit: bigint;
}

class PendleArbKeeper {
  private provider: ethers.JsonRpcProvider;
  private wallet: ethers.Wallet;
  private arbContract: ethers.Contract;
  private config = config;
  private isRunning: boolean = false;
  private pendleApiUrl = 'https://api.pendle.finance/core/v1/42161';
  private lastCheckTime: Date = new Date();
  private opportunitiesFound: number = 0;
  private executedTrades: number = 0;

  constructor() {
    this.provider = new ethers.JsonRpcProvider(config.rpcUrl);
    this.wallet = new ethers.Wallet(config.privateKey, this.provider);
    
    if (config.arbContractAddress) {
      this.arbContract = new ethers.Contract(
        config.arbContractAddress,
        ARB_CONTRACT_ABI,
        this.wallet
      );
    }
  }

  async initialize() {
    console.log('Initializing Pendle Arbitrage Keeper...');
    console.log('Wallet address:', this.wallet.address);
    
    // Log status periodically for monitoring
    this.startStatusLogger();
    
    if (!config.arbContractAddress) {
      console.error('ARB_CONTRACT_ADDRESS not set in .env');
      console.log('Please deploy the contract first using: forge script script/deploy.s.sol --rpc-url arbitrum --broadcast');
      process.exit(1);
    }

    // Verify contract is deployed
    try {
      const code = await this.provider.getCode(config.arbContractAddress);
      if (code === '0x') {
        console.log('Contract not yet deployed to blockchain at:', config.arbContractAddress);
        console.log('Running in simulation mode...');
      } else {
        // Verify ownership only if contract is deployed
        const owner = await this.arbContract.owner();
        if (owner.toLowerCase() !== this.wallet.address.toLowerCase()) {
          console.error('Wallet is not the owner of the arbitrage contract');
          process.exit(1);
        }
        console.log('Contract verified at:', config.arbContractAddress);
      }
    } catch (error) {
      console.warn('Warning: Could not verify contract, running in simulation mode');
    }

    console.log('Keeper initialized successfully');
  }

  async fetchActiveMarkets(): Promise<MarketData[]> {
    try {
      console.log('Fetching active markets from Pendle API...');
      
      // Fetch active markets from Pendle API for Arbitrum (chain 42161)
      const response = await fetch(`https://api-v2.pendle.finance/core/v1/42161/markets`);
      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }
      
      const apiData = await response.json();
      const activeMarkets: MarketData[] = [];
      
      if (!apiData.results || !Array.isArray(apiData.results)) {
        console.log('No markets data in API response');
        return [];
      }
      
      console.log(`API returned ${apiData.results.length} potential markets`);
      
      // Process each market from the API
      for (const marketData of apiData.results) {
        try {
          // Skip if market doesn't have required fields
          if (!marketData.address || !marketData.pt || !marketData.yt || !marketData.sy) {
            continue;
          }
          
          // Convert expiry to date for validation (handle both timestamp and ISO string)
          let expiryDate: Date;
          try {
            if (typeof marketData.expiry === 'number') {
              expiryDate = new Date(marketData.expiry * 1000);
            } else if (typeof marketData.expiry === 'string') {
              expiryDate = new Date(marketData.expiry);
            } else {
              console.log(`Skipping market with invalid expiry: ${marketData.name}`);
              continue;
            }
          } catch (e) {
            console.log(`Skipping market with unparseable expiry: ${marketData.name}`);
            continue;
          }
          
          const now = new Date();
          
          // Skip expired markets
          if (expiryDate <= now) {
            console.log(`Skipping expired market: ${marketData.name} (expired ${expiryDate.toISOString()})`);
            continue;
          }
          
          // Create market data structure
          const market: MarketData = {
            address: marketData.address,
            name: marketData.name || `Market-${marketData.address.slice(0, 8)}`,
            yt: { address: marketData.yt.address },
            pt: { address: marketData.pt.address },
            sy: { address: marketData.sy.address },
            underlyingAsset: { 
              address: marketData.underlyingAsset?.address || marketData.sy.address 
            },
            liquidity: { 
              usd: marketData.liquidity?.usd || marketData.totalLiquidity || 0 
            },
            isExpired: false
          };
          
          // Validate the market has reasonable liquidity (min $100k)
          if (market.liquidity.usd < 100000) {
            console.log(`Skipping low liquidity market: ${market.name} ($${market.liquidity.usd})`);
            continue;
          }
          
          // Double-check expiry by calling the YT contract
          try {
            const ytContract = new ethers.Contract(market.yt.address, YT_ABI, this.provider);
            const isExpired = await ytContract.isExpired();
            if (isExpired) {
              console.log(`Market ${market.name} shows as expired in YT contract`);
              continue;
            }
          } catch (e) {
            console.log(`Could not verify expiry for ${market.name}, including anyway`);
          }
          
          activeMarkets.push(market);
          console.log(`Added active market: ${market.name} (expires ${expiryDate.toISOString()}) - $${market.liquidity.usd.toLocaleString()}`);
          
        } catch (error) {
          console.log(`Error processing market ${marketData?.name || marketData?.address}: ${error}`);
        }
      }

      console.log(`Found ${activeMarkets.length} active markets with sufficient liquidity`);
      return activeMarkets;
    } catch (error) {
      console.error('Error fetching markets from API:', error);
      console.log('Falling back to empty market list');
      return [];
    }
  }

  async calculateArbProfit(
    market: MarketData,
    testSize: bigint
  ): Promise<{ profitBps: number; expectedProfit: bigint } | null> {
    try {
      const marketContract = new ethers.Contract(market.address, MARKET_ABI, this.provider);
      const ytContract = new ethers.Contract(market.yt.address, YT_ABI, this.provider);
      
      // Get current market state - using Pendle router address for readState
      let totalPt, totalSy;
      try {
        [totalPt, totalSy] = await marketContract.readState(this.config.pendleRouter);
      } catch (readStateError) {
        console.log(`Skipping market ${market.name}: Unable to read state (market may be expired or invalid)`);
        return null;
      }
      
      const pyIndex = await ytContract.pyIndexCurrent();
      
      // Use the total balances as reserves
      const syReserve = totalSy;
      const ptReserve = totalPt;
      
      // Estimate swap rates based on reserves (simplified AMM model)
      // In production, use RouterStatic or simulate actual swap calls
      const k = syReserve * ptReserve; // constant product
      
      // PT -> SY swap (sell PT)
      const newPtReserve = ptReserve + testSize;
      const newSyReserveAfterSell = k / newPtReserve;
      const syFromSell = syReserve - newSyReserveAfterSell;
      
      // SY -> PT swap (buy PT) - on updated reserves
      const newSyReserveForBuy = newSyReserveAfterSell + (testSize * 102n / 100n); // estimate with 2% slippage
      const syForBuy = newSyReserveForBuy - newSyReserveAfterSell;
      
      // Calculate profit in SY terms
      if (syFromSell <= syForBuy) {
        return null; // No profit opportunity
      }
      
      const syProfit = syFromSell - syForBuy;
      
      // Account for mint/redeem costs (typically ~0.1% each)
      const mintRedeemCost = (testSize * 20n) / 10000n; // 0.2% total
      const netProfit = syProfit > mintRedeemCost ? syProfit - mintRedeemCost : 0n;
      
      if (netProfit === 0n) {
        return null;
      }
      
      // Calculate profit in basis points
      const profitBps = Number((netProfit * 10000n) / testSize);
      
      // Estimate gas costs (roughly 500k gas at 0.1 gwei)
      const gasEstimate = 500000n * ethers.parseUnits('0.1', 'gwei');
      const expectedProfit = netProfit - gasEstimate;
      
      if (expectedProfit <= 0) {
        return null;
      }
      
      return {
        profitBps,
        expectedProfit
      };
    } catch (error) {
      // Silently skip this market - likely an issue with market data
      return null;
    }
  }

  async findArbOpportunities(markets: MarketData[]): Promise<ArbOpportunity[]> {
    const opportunities: ArbOpportunity[] = [];
    
    for (const market of markets) {
      // Test multiple sizes to find optimal
      const testSizes = [
        ethers.parseEther('10'),
        ethers.parseEther('100'),
        ethers.parseEther('1000'),
        ethers.parseEther('10000'),
      ];
      
      let bestOpp: ArbOpportunity | null = null;
      
      for (const size of testSizes) {
        const result = await this.calculateArbProfit(market, size);
        
        if (result && result.profitBps >= config.minProfitBps) {
          const opp: ArbOpportunity = {
            market: market.address,
            yt: market.yt.address,
            pt: market.pt.address,
            sy: market.sy.address,
            underlying: market.underlyingAsset.address,
            profitBps: result.profitBps,
            optimalSize: size,
            expectedProfit: result.expectedProfit,
          };
          
          if (!bestOpp || opp.expectedProfit > bestOpp.expectedProfit) {
            bestOpp = opp;
          }
        }
      }
      
      if (bestOpp) {
        opportunities.push(bestOpp);
        console.log(`Found opportunity in market ${market.name}: ${bestOpp.profitBps} bps`);
      }
    }
    
    // Sort by expected profit
    opportunities.sort((a, b) => {
      if (a.expectedProfit > b.expectedProfit) return -1;
      if (a.expectedProfit < b.expectedProfit) return 1;
      return 0;
    });
    
    return opportunities;
  }

  async executeArbitrage(opp: ArbOpportunity): Promise<boolean> {
    try {
      console.log(`Executing arbitrage for market ${opp.market}`);
      console.log(`Expected profit: ${ethers.formatEther(opp.expectedProfit)} tokens`);
      
      // Check if contract is deployed
      const code = await this.provider.getCode(config.arbContractAddress);
      if (code === '0x') {
        console.log('SIMULATION: Would execute arbitrage with params:');
        console.log({
          market: opp.market,
          flashAmount: ethers.formatEther(opp.optimalSize),
          expectedProfit: ethers.formatEther(opp.expectedProfit),
          profitBps: opp.profitBps
        });
        return true;
      }
      
      // Build transaction parameters
      const params = {
        vault: config.balancerVault,
        router: config.pendleRouter,
        underlying: opp.underlying,
        yt: opp.yt,
        market: opp.market,
        flashAmount: opp.optimalSize,
        pyToCycle: opp.optimalSize, // Assuming 1:1 for simplicity
        minUnderlyingOut: opp.optimalSize + (opp.expectedProfit * 8n / 10n), // 80% of expected profit
      };
      
      // Estimate gas
      const gasEstimate = await this.arbContract.executeArb.estimateGas(params);
      const gasPrice = await this.provider.getFeeData();
      
      // Execute transaction
      const tx = await this.arbContract.executeArb(params, {
        gasLimit: gasEstimate * 120n / 100n, // 20% buffer
        gasPrice: gasPrice.gasPrice,
      });
      
      console.log(`Transaction sent: ${tx.hash}`);
      const receipt = await tx.wait();
      
      if (receipt.status === 1) {
        console.log(`Arbitrage successful! Gas used: ${receipt.gasUsed}`);
        return true;
      } else {
        console.error('Transaction failed');
        return false;
      }
    } catch (error) {
      console.error('Error executing arbitrage:', error);
      return false;
    }
  }

  async runLoop() {
    console.log('Starting arbitrage scanning loop...');
    this.isRunning = true;
    
    while (this.isRunning) {
      try {
        // Fetch active markets
        const markets = await this.fetchActiveMarkets();
        
        // Find arbitrage opportunities
        const opportunities = await this.findArbOpportunities(markets);
        this.lastCheckTime = new Date();
        this.opportunitiesFound += opportunities.length;
        
        if (opportunities.length > 0) {
          console.log(`Found ${opportunities.length} arbitrage opportunities`);
          
          // Execute the best opportunity
          const best = opportunities[0];
          const success = await this.executeArbitrage(best);
          if (success) {
            this.executedTrades++;
          }
        } else {
          console.log('No profitable opportunities found');
        }
        
        // Wait before next scan
        await new Promise(resolve => setTimeout(resolve, config.pollingInterval));
      } catch (error) {
        console.error('Error in main loop:', error);
        await new Promise(resolve => setTimeout(resolve, config.pollingInterval));
      }
    }
  }

  stop() {
    console.log('Stopping keeper...');
    this.isRunning = false;
  }

  private startStatusLogger() {
    // Log status every 5 minutes for Render logs monitoring
    setInterval(() => {
      console.log('=== STATUS UPDATE ===');
      console.log(`Uptime: ${Math.floor(process.uptime() / 60)} minutes`);
      console.log(`Last check: ${this.lastCheckTime.toISOString()}`);
      console.log(`Opportunities found: ${this.opportunitiesFound}`);
      console.log(`Trades executed: ${this.executedTrades}`);
      console.log(`Wallet: ${this.wallet.address}`);
      console.log(`Running: ${this.isRunning}`);
      console.log('===================');
    }, 5 * 60 * 1000); // Every 5 minutes
  }
}

// Main execution
async function main() {
  const keeper = new PendleArbKeeper();
  
  // Handle graceful shutdown
  process.on('SIGINT', () => {
    keeper.stop();
    process.exit(0);
  });
  
  process.on('SIGTERM', () => {
    keeper.stop();
    process.exit(0);
  });
  
  try {
    await keeper.initialize();
    await keeper.runLoop();
  } catch (error) {
    console.error('Fatal error:', error);
    process.exit(1);
  }
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}

export { PendleArbKeeper };