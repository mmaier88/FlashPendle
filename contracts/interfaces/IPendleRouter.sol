// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPendleRouter {
    enum SwapType {
        NONE,
        KYBERSWAP,
        ONE_INCH,
        ETH_WETH
    }

    struct SwapData {
        SwapType swapType;
        address extRouter;
        bytes extCalldata;
        bool needScale;
    }

    struct TokenInput {
        address tokenIn;
        uint256 netTokenIn;
        address tokenMintSy;
        address pendleSwap;
        SwapData swapData;
    }

    struct TokenOutput {
        address tokenOut;
        uint256 minTokenOut;
        address tokenRedeemSy;
        address pendleSwap;
        SwapData swapData;
    }

    function mintSyFromToken(
        address receiver,
        address SY,
        uint256 minSyOut,
        TokenInput calldata input
    ) external returns (uint256 netSyOut);

    function redeemSyToToken(
        address receiver,
        address SY,
        uint256 netSyIn,
        TokenOutput calldata output
    ) external returns (uint256 netTokenOut);

    function mintPyFromToken(
        address receiverPT,
        address receiverYT,
        address YT,
        uint256 minPyOut,
        TokenInput calldata input
    ) external returns (uint256 netPyOut);

    function redeemPyToToken(
        address receiver,
        address YT,
        uint256 netPyIn,
        TokenOutput calldata output
    ) external returns (uint256 netTokenOut);
}