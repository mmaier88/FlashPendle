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
  'function getReserves() view returns (uint256 syReserve, uint256 ptReserve)',
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
      // Hardcoded known Pendle markets on Arbitrum (as of 2024)
      // These are some of the most liquid markets - replace with actual addresses from Pendle app
      const knownMarkets = [
        {
          address: '0x2FCb47B58350cD377f94d3821e7373Df60bD9Ced', // wstETH 26DEC24
          name: 'wstETH-26DEC24',
          yt: { address: '0x4ba89e3584710cf5f7f1b541cb2b989d53a64355' },
          pt: { address: '0x1c085195437738d73d75DC64bC5A3E098b7f93b1' },
          sy: { address: '0x80c12D5b6Cc494632Bf11b03F09436c489B7b5C3' },
          underlyingAsset: { address: '0x5979D7b546E38E414F7E9822514be443A4800529' }, // wstETH
          liquidity: { usd: 10000000 },
          isExpired: false
        },
        {
          address: '0x34280882267fFA6383b363e278B027bE083bbe21', // rsETH 26DEC24
          name: 'rsETH-26DEC24',
          yt: { address: '0xacc8B10daebE0F22dFDC3b25ba2506d96Ed86663' },
          pt: { address: '0xb72e76Ef2A0d08c5c4B1a1D4529d4F6aCDc8Bf37' },
          sy: { address: '0xd2605A61F730e01Dd454Db4e46d0Df8a7Ab090b7' },
          underlyingAsset: { address: '0x4186BFC76E2E237523CBC30FD220FE055156b41F' }, // rsETH
          liquidity: { usd: 5000000 },
          isExpired: false
        }
      ];

      // Check if markets are expired by calling isExpired on YT contracts
      const activeMarkets: MarketData[] = [];
      for (const market of knownMarkets) {
        try {
          const ytContract = new ethers.Contract(market.yt.address, YT_ABI, this.provider);
          const isExpired = await ytContract.isExpired();
          if (!isExpired) {
            activeMarkets.push(market as MarketData);
          }
        } catch (e) {
          // If we can't check, assume it's active
          activeMarkets.push(market as MarketData);
        }
      }

      console.log(`Found ${activeMarkets.length} active markets`);
      return activeMarkets;
    } catch (error) {
      console.error('Error fetching markets:', error);
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
      
      // Get current reserves
      const [syReserve, ptReserve] = await marketContract.getReserves();
      const pyIndex = await ytContract.pyIndexCurrent();
      
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
      console.error('Error calculating arb profit:', error);
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