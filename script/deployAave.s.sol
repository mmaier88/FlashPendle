// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/ArbPendleSplitMergeAave.sol";

contract DeployAaveScript is Script {
    function run() external {
        // Load environment variables
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address aaveAddressesProvider = vm.envAddress("AAVE_ADDRESSES_PROVIDER");
        address pendleRouter = vm.envAddress("PENDLE_ROUTER_V4");
        
        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy the arbitrage contract with Aave V3
        ArbPendleSplitMergeAave arbContract = new ArbPendleSplitMergeAave(
            aaveAddressesProvider,
            pendleRouter
        );
        
        console.log("ArbPendleSplitMergeAave deployed at:", address(arbContract));
        console.log("Owner:", arbContract.owner());
        console.log("AddressesProvider:", arbContract.ADDRESSES_PROVIDER());
        console.log("Router:", arbContract.ROUTER());
        
        vm.stopBroadcast();
        
        // Output deployment address for manual copying
        console.log("===================================");
        console.log("AAVE V3 DEPLOYMENT COMPLETE!");
        console.log("Add this to your .env file:");
        console.log("ARB_CONTRACT_ADDRESS=", address(arbContract));
        console.log("===================================");
    }
}