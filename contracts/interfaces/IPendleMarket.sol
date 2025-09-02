// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPendleMarket {
    function swapExactPtForSy(
        address receiver, 
        uint256 exactPtIn, 
        bytes calldata data
    ) external returns (uint256 netSyOut, uint256 netSyFee);

    function swapSyForExactPt(
        address receiver, 
        uint256 exactPtOut, 
        bytes calldata data
    ) external returns (uint256 netSyIn, uint256 netSyFee);

    function getReserves() external view returns (uint256 syReserve, uint256 ptReserve);

    function readState(address router) external view returns (
        uint256 totalPt,
        uint256 totalSy,
        uint256 totalLp,
        uint256 lastLnImpliedRate
    );
}