// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IPendleMarket.sol";
import "./interfaces/IPYieldToken.sol";
import "./interfaces/IPendleRouter.sol";
import "./interfaces/IERC20.sol";

// Aave V3 interfaces
interface IPoolAddressesProvider {
    function getPool() external view returns (address);
}

interface IPool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IFlashLoanSimpleReceiver {
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool);
}

contract ArbPendleSplitMergeAave is IFlashLoanSimpleReceiver {
    error Unauthorized();
    error Expired();
    error NoProfit();
    error InsufficientOutput();

    struct ArbParams {
        address pool;             // Aave V3 Pool
        address router;           // Pendle RouterV4
        address underlying;       // token to flash-borrow (e.g., wstETH/USDC)
        address yt;               // YT address for the chosen market (derives PT & SY)
        address market;           // Pendle PT/SY Market
        uint256 flashAmount;      // underlying amount to borrow
        uint256 pyToCycle;        // how much PY (PT+YT) to mint/swap/redeem (in 1e18 token units)
        uint256 minUnderlyingOut; // repay + profit guard
    }

    address public immutable ADDRESSES_PROVIDER; // 0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb (Arbitrum)
    address public immutable ROUTER;             // 0x888888888889758F76e7103c6CbF23ABbF58F946
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _addressesProvider, address _router) {
        ADDRESSES_PROVIDER = _addressesProvider;
        ROUTER = _router;
        owner = msg.sender;
    }

    function executeArb(ArbParams memory p) external onlyOwner {
        address pool = IPoolAddressesProvider(ADDRESSES_PROVIDER).getPool();
        bytes memory params = abi.encode(p);
        
        IPool(pool).flashLoanSimple(
            address(this),
            p.underlying,
            p.flashAmount,
            params,
            0 // referralCode
        );
    }

    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external override returns (bool) {
        // Verify initiator is this contract and sender is Aave pool
        if (initiator != address(this)) revert Unauthorized();
        
        address pool = IPoolAddressesProvider(ADDRESSES_PROVIDER).getPool();
        if (msg.sender != pool) revert Unauthorized();

        ArbParams memory p = abi.decode(params, (ArbParams));

        IERC20 U = IERC20(asset);
        uint256 flashAmt = amount;
        uint256 fee = premium;

        IPYieldToken YT = IPYieldToken(p.yt);
        if (YT.isExpired()) revert Expired();
        address PT = YT.PT();
        address SY = YT.SY();
        IPendleMarket M = IPendleMarket(p.market);

        // Set up approvals (max for efficiency)
        IERC20(SY).approve(p.yt, type(uint256).max);
        IERC20(PT).approve(p.yt, type(uint256).max);
        IERC20(PT).approve(p.market, type(uint256).max);
        IERC20(SY).approve(p.market, type(uint256).max);
        IERC20(SY).approve(ROUTER, type(uint256).max);
        U.approve(ROUTER, type(uint256).max);

        // Step 1: Convert underlying to SY via Router
        IPendleRouter.TokenInput memory tokenInput = IPendleRouter.TokenInput({
            tokenIn: p.underlying,
            netTokenIn: flashAmt,
            tokenMintSy: p.underlying,
            pendleSwap: address(0),
            swapData: IPendleRouter.SwapData({
                swapType: IPendleRouter.SwapType.NONE,
                extRouter: address(0),
                extCalldata: "",
                needScale: false
            })
        });

        uint256 syReceived = IPendleRouter(ROUTER).mintSyFromToken(
            address(this),
            SY,
            0, // minSyOut - we'll check at the end
            tokenInput
        );

        // Step 2: Mint PY (PT+YT) from SY
        uint256 syToMint = syReceived > p.pyToCycle ? p.pyToCycle : syReceived;
        IERC20(SY).transfer(p.yt, syToMint);
        uint256 pyMinted = YT.mintPY(address(this), address(this));

        uint256 cycle = pyMinted > p.pyToCycle ? p.pyToCycle : pyMinted;

        // Step 3: SELL PT -> SY (exploit high PT price)
        (uint256 syOutFromSell, ) = M.swapExactPtForSy(
            address(this), 
            cycle, 
            abi.encode(0) // minSyOut encoded as bytes
        );

        // Step 4: BUY BACK PT with SY (exploit low PT price)
        (uint256 syInForBuy, ) = M.swapSyForExactPt(
            address(this), 
            cycle, 
            abi.encode(type(uint256).max) // maxSyIn encoded as bytes
        );

        // Step 5: MERGE PT+YT back to SY
        uint256 syFromRedeem = YT.redeemPY(address(this));

        // Step 6: Convert all SY back to underlying
        uint256 syTotal = IERC20(SY).balanceOf(address(this));
        
        IPendleRouter.TokenOutput memory tokenOutput = IPendleRouter.TokenOutput({
            tokenOut: p.underlying,
            minTokenOut: p.minUnderlyingOut,
            tokenRedeemSy: p.underlying,
            pendleSwap: address(0),
            swapData: IPendleRouter.SwapData({
                swapType: IPendleRouter.SwapType.NONE,
                extRouter: address(0),
                extCalldata: "",
                needScale: false
            })
        });

        uint256 underlyingOut = IPendleRouter(ROUTER).redeemSyToToken(
            address(this),
            SY,
            syTotal,
            tokenOutput
        );

        // Step 7: Repay flash loan and verify profit
        uint256 repayAmount = flashAmt + fee;
        if (underlyingOut < repayAmount) revert InsufficientOutput();
        
        // Approve Aave pool to pull repayment
        U.approve(pool, repayAmount);
        
        uint256 profit = U.balanceOf(address(this)) - repayAmount;
        if (profit == 0) revert NoProfit();
        
        // Send profit to owner
        U.transfer(owner, profit);

        return true;
    }

    // Emergency functions
    function rescueToken(address token, uint256 amount) external onlyOwner {
        IERC20(token).transfer(owner, amount);
    }

    function updateOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        owner = newOwner;
    }
}