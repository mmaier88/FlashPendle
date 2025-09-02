// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Script.sol";
import "../contracts/ArbPendleSplitMerge.sol";

contract DeployScript is Script {
    function run() external {
        // Load environment variables
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        address balancerVault = vm.envAddress("BALANCER_VAULT");
        address pendleRouter = vm.envAddress("PENDLE_ROUTER_V4");
        
        // Start broadcasting transactions
        vm.startBroadcast(deployerPrivateKey);
        
        // Deploy the arbitrage contract
        ArbPendleSplitMerge arbContract = new ArbPendleSplitMerge(
            balancerVault,
            pendleRouter
        );
        
        console.log("ArbPendleSplitMerge deployed at:", address(arbContract));
        console.log("Owner:", arbContract.owner());
        console.log("Vault:", arbContract.VAULT());
        console.log("Router:", arbContract.ROUTER());
        
        vm.stopBroadcast();
        
        // Output deployment address for manual copying
        console.log("===================================");
        console.log("DEPLOYMENT COMPLETE!");
        console.log("Add this to your .env file:");
        console.log("ARB_CONTRACT_ADDRESS=", address(arbContract));
        console.log("===================================");
    }
}