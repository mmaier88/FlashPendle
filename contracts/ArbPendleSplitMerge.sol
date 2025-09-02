// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./interfaces/IVault.sol";
import "./interfaces/IFlashLoanRecipient.sol";
import "./interfaces/IPendleMarket.sol";
import "./interfaces/IPYieldToken.sol";
import "./interfaces/IPendleRouter.sol";
import "./interfaces/IERC20.sol";

contract ArbPendleSplitMerge is IFlashLoanRecipient {
    error NotVault();
    error Expired();
    error NoProfit();
    error InsufficientOutput();

    struct ArbParams {
        address vault;            // Balancer V2 Vault
        address router;           // Pendle RouterV4
        address underlying;       // token to flash-borrow (e.g., wstETH/USDC)
        address yt;               // YT address for the chosen market (derives PT & SY)
        address market;           // Pendle PT/SY Market
        uint256 flashAmount;      // underlying amount to borrow
        uint256 pyToCycle;        // how much PY (PT+YT) to mint/swap/redeem (in 1e18 token units)
        uint256 minUnderlyingOut; // repay + profit guard
    }

    address public immutable VAULT;
    address public immutable ROUTER;
    address public owner;

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    constructor(address _vault, address _router) {
        VAULT = _vault;   // 0xBA12222222228d8Ba445958a75a0704d566BF2C8 (Arbitrum)
        ROUTER = _router; // 0x888888888889758F76e7103c6CbF23ABbF58F946
        owner = msg.sender;
    }

    function executeArb(ArbParams memory p) external onlyOwner {
        address[] memory tokens = new address[](1);
        uint256[] memory amounts = new uint256[](1);
        tokens[0] = p.underlying;
        amounts[0] = p.flashAmount;

        bytes memory data = abi.encode(p);
        IVault(VAULT).flashLoan(address(this), tokens, amounts, data);
    }

    function receiveFlashLoan(
        address[] calldata tokens,
        uint256[] calldata amounts,
        uint256[] calldata feeAmounts,
        bytes calldata userData
    ) external override {
        if (msg.sender != VAULT) revert NotVault();
        ArbParams memory p = abi.decode(userData, (ArbParams));

        IERC20 U = IERC20(tokens[0]);
        uint256 flashAmt = amounts[0];
        uint256 fee = feeAmounts[0];

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
        // Transfer SY to YT contract first
        uint256 syToMint = syReceived > p.pyToCycle ? p.pyToCycle : syReceived;
        IERC20(SY).transfer(p.yt, syToMint);
        uint256 pyMinted = YT.mintPY(address(this), address(this));

        // Use the minimum of minted and requested cycle amount
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
        // Both PT and YT should be in this contract
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
        
        U.transfer(VAULT, repayAmount);
        
        uint256 profit = U.balanceOf(address(this));
        if (profit == 0) revert NoProfit();
        
        // Send profit to owner
        U.transfer(owner, profit);
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