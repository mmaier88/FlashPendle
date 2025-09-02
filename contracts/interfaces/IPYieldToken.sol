// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IPYieldToken {
    function PT() external view returns (address);
    function SY() external view returns (address);
    function isExpired() external view returns (bool);
    function expiry() external view returns (uint256);

    // Mint PY (PT+YT) from SY - requires SY to be transferred first
    function mintPY(address receiverPT, address receiverYT) external returns (uint256 amountPYOut);
    
    // Redeem PY (PT+YT) back to SY
    function redeemPY(address receiver) external returns (uint256 amountSyOut);
    
    // Get conversion rates
    function pyIndexStored() external view returns (uint256);
    function pyIndexCurrent() external returns (uint256);
}