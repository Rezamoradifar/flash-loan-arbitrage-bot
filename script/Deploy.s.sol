// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AaveArbitrageExecutorV3} from "../src/AaveArbitrageExecutorV3.sol";

/// @notice Deploys AaveArbitrageExecutorV3 pointed at a real Aave V3 Pool.
///         Router/asset whitelisting and keeper assignment are left as
///         separate owner transactions (see README) so the deployer can
///         review addresses before granting them any trust.
///
/// Usage against a real chain (you supply PRIVATE_KEY, AAVE_POOL,
/// PROFIT_RECIPIENT, OWNER as env vars):
///   forge script script/Deploy.s.sol:Deploy --rpc-url $RPC_URL --broadcast
///
/// Usage against a local anvil instance for testing (defaults fall back to
/// the anvil dev account and a freshly deployed MockAavePool):
///   forge script script/Deploy.s.sol:Deploy --rpc-url http://127.0.0.1:8545 --broadcast
contract Deploy is Script {
    function run() external returns (AaveArbitrageExecutorV3 executor) {
        address aavePool = vm.envAddress("AAVE_POOL");
        address profitRecipient = vm.envOr("PROFIT_RECIPIENT", msg.sender);
        address owner = vm.envOr("OWNER", msg.sender);

        vm.startBroadcast();
        executor = new AaveArbitrageExecutorV3(aavePool, profitRecipient, owner);
        vm.stopBroadcast();

        console.log("AaveArbitrageExecutorV3 deployed at:", address(executor));
        console.log("  AAVE_POOL:       ", aavePool);
        console.log("  profitRecipient: ", profitRecipient);
        console.log("  owner:           ", owner);
    }
}
