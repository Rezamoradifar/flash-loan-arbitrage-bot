// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script, console} from "forge-std/Script.sol";
import {AaveArbitrageExecutorV3} from "../src/AaveArbitrageExecutorV3.sol";
import {MockERC20} from "../src/mocks/MockERC20.sol";
import {MockAavePool} from "../src/mocks/MockAavePool.sol";
import {MockRouterV2} from "../src/mocks/MockRouterV2.sol";

/// @notice End-to-end LOCAL demo: deploys mock tokens, three mock DEX pools
///         (one deliberately mispriced), a mock Aave V3 pool, and the
///         executor contract, wires up the whitelist, then actually calls
///         executeArbitrage() against a live anvil node — a real broadcast
///         transaction that takes a real flash loan, runs the triangular
///         swap, repays Aave with the premium, and pays out profit.
///
///         This is a demo/testing harness only. It does NOT touch any real
///         DEX or real Aave deployment — see README for how to point the
///         plain Deploy.s.sol script at real BSC mainnet/testnet contracts.
///
/// Usage:
///   anvil &
///   forge script script/DeployLocalDemo.s.sol:DeployLocalDemo \
///     --rpc-url http://127.0.0.1:8545 \
///     --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
///     --broadcast
contract DeployLocalDemo is Script {
    MockERC20 usdt;
    MockERC20 tokX;
    MockERC20 tokY;
    MockAavePool aavePool;
    MockRouterV2 routerA;
    MockRouterV2 routerB;
    MockRouterV2 routerC;
    AaveArbitrageExecutorV3 executor;

    function run() external {
        vm.startBroadcast();
        address deployer = msg.sender;

        _deployTokensAndPools();
        _deployExecutor(deployer);

        uint256 profitBefore = usdt.balanceOf(deployer);
        console.log("== Before ==");
        console.log("Aave pool USDT liquidity:", usdt.balanceOf(address(aavePool)));
        console.log("Deployer/profitRecipient USDT balance:", profitBefore);

        executor.executeArbitrage(address(usdt), 100_000e18, _triangularSteps(), 0, 0);

        _logAfter(deployer, profitBefore);
        vm.stopBroadcast();
    }

    function _deployTokensAndPools() internal {
        usdt = new MockERC20("Tether USD", "USDT", 18);
        tokX = new MockERC20("Token X", "TOKX", 18);
        tokY = new MockERC20("Token Y", "TOKY", 18);

        aavePool = new MockAavePool();
        usdt.mint(address(aavePool), 50_000_000e18);

        routerA = new MockRouterV2(address(usdt), address(tokX), 10_000_000e18, 10_000_000e18, 30);
        usdt.mint(address(routerA), 10_000_000e18);
        tokX.mint(address(routerA), 10_000_000e18);

        routerB = new MockRouterV2(address(tokX), address(tokY), 10_000_000e18, 10_000_000e18, 30);
        tokX.mint(address(routerB), 10_000_000e18);
        tokY.mint(address(routerB), 10_000_000e18);

        // Deliberately mispriced pool -> the exploitable arbitrage edge.
        routerC = new MockRouterV2(address(tokY), address(usdt), 8_000_000e18, 12_000_000e18, 30);
        tokY.mint(address(routerC), 8_000_000e18);
        usdt.mint(address(routerC), 12_000_000e18);
    }

    function _deployExecutor(address deployer) internal {
        executor = new AaveArbitrageExecutorV3(address(aavePool), deployer, deployer);
        executor.setRouterAllowed(address(routerA), true);
        executor.setRouterAllowed(address(routerB), true);
        executor.setRouterAllowed(address(routerC), true);
        executor.setAssetAllowed(address(usdt), true, 0);
        executor.setKeeper(deployer);
    }

    function _triangularSteps() internal view returns (AaveArbitrageExecutorV3.SwapStep[] memory steps) {
        steps = new AaveArbitrageExecutorV3.SwapStep[](3);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(address(routerA), address(0), 0, address(usdt), address(tokX), 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(address(routerB), address(0), 0, address(tokX), address(tokY), 0, 0, 0);
        steps[2] = AaveArbitrageExecutorV3.SwapStep(address(routerC), address(0), 0, address(tokY), address(usdt), 0, 0, 0);
    }

    function _logAfter(address deployer, uint256 profitBefore) internal view {
        console.log("== After ==");
        console.log("Aave pool USDT liquidity:", usdt.balanceOf(address(aavePool)));
        uint256 balAfter = usdt.balanceOf(deployer);
        console.log("Deployer/profitRecipient USDT balance:", balAfter);
        console.log("Net profit realized:", balAfter - profitBefore);
        (uint256 totalOps, uint256 flashLoans, uint256 totalProfit) = executor.getOperationStats();
        console.log("operationCount:", totalOps);
        console.log("totalFlashLoansExecuted:", flashLoans);
        console.log("totalProfitRealized:", totalProfit);
        console.log("executor address:", address(executor));
    }
}
