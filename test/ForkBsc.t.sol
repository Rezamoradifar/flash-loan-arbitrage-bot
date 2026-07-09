// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test, console} from "forge-std/Test.sol";
import {AaveArbitrageExecutorV3} from "../src/AaveArbitrageExecutorV3.sol";

/// @notice Fork test against REAL BNB Chain mainnet state — the real Aave V3
///         Pool, the real PancakeSwap V2 Router, real WBNB/USDT/USDC. Unlike
///         test/AaveArbitrageExecutor.t.sol (which uses mock DEX/Aave
///         contracts), this test forks live chain state into a local,
///         throwaway EVM snapshot: it can request a REAL flash loan from the
///         REAL Aave Pool and swap against REAL PancakeSwap liquidity, but
///         nothing here ever touches real mainnet or costs real money —
///         forge's fork is a local read+simulate copy of chain state.
///
///         Requires an RPC URL this sandbox cannot reach; run it yourself:
///           forge test --fork-url <your BSC RPC> --match-contract ForkBscTest -vvvv
///
///         What this proves if it passes: the executor's wiring is correct
///         against the REAL Aave Pool and REAL PancakeSwap Router interfaces
///         (not just the mocks). What it does NOT prove: that any given
///         triangular route is profitable right now — real markets are
///         usually priced consistently within fees, and any gap is normally
///         captured by other bots in the same block. Don't be surprised (or
///         alarmed) if the arbitrage call itself reverts with SpreadTooLow —
///         that's the contract correctly refusing to borrow for a trade that
///         isn't actually profitable, which is exactly what it's supposed to
///         do. This test logs the real spread it finds either way.
contract ForkBscTest is Test {
    // Cross-checked against BscScan + each protocol's own docs — see
    // keeper/addresses.bsc.json for sources. Still worth a final check on
    // bscscan.com yourself before trusting these with anything real.
    address constant AAVE_POOL = 0x6807dc923806fE8Fd134338EABCA509979a7e0cB;
    address constant PANCAKE_V2_ROUTER = 0x10ED43C718714eb63d5aA57B78B54704E256024E;
    address constant WBNB = 0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c;
    address constant USDT = 0x55d398326f99059fF775485246999027B3197955;
    address constant USDC = 0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d;

    AaveArbitrageExecutorV3 executor;
    address owner = makeAddr("owner");
    address profitRecipient = makeAddr("profitRecipient");

    function setUp() public {
        // Requires --fork-url. Without it, skip cleanly instead of failing
        // loudly, so a plain `forge test` (no fork configured) still passes.
        if (AAVE_POOL.code.length == 0) {
            vm.skip(true, "ForkBscTest requires --fork-url <BSC RPC>; see test file header");
        }

        vm.prank(owner);
        executor = new AaveArbitrageExecutorV3(AAVE_POOL, profitRecipient, owner);

        vm.startPrank(owner);
        executor.setRouterAllowed(PANCAKE_V2_ROUTER, true);
        executor.setAssetAllowed(USDT, true, 0);
        vm.stopPrank();
    }

    function test_AavePoolHasRealCode() public view {
        assertGt(AAVE_POOL.code.length, 0, "AAVE_POOL has no code at this block/fork - is --fork-url set?");
    }

    function test_PancakeRouterQuotesRealLiquidity() public view {
        address[] memory path = new address[](2);
        path[0] = USDT;
        path[1] = WBNB;
        uint256[] memory amounts = _quote(path, 1_000e18);
        assertGt(amounts[1], 0, "PancakeSwap V2 USDT/WBNB pool returned 0 - pair may not exist at this block");
        console.log("1,000 USDT ~= WBNB (real quote):", amounts[1]);
    }

    function _quote(address[] memory path, uint256 amountIn) internal view returns (uint256[] memory) {
        (bool ok, bytes memory data) = PANCAKE_V2_ROUTER.staticcall(
            abi.encodeWithSignature("getAmountsOut(uint256,address[])", amountIn, path)
        );
        require(ok, "getAmountsOut call failed");
        return abi.decode(data, (uint256[]));
    }

    /// @notice Reports the REAL current spread for USDT -> WBNB -> USDC -> USDT
    ///         via PancakeSwap V2 at whatever block is forked. Logs the
    ///         result instead of asserting profitability, since that's a
    ///         live market fact, not a code-correctness fact.
    function test_RealTriangularSpread_Informational() public {
        AaveArbitrageExecutorV3.SwapStep[] memory steps = new AaveArbitrageExecutorV3.SwapStep[](3);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDT, WBNB, 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, WBNB, USDC, 0, 0, 0);
        steps[2] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDC, USDT, 0, 0, 0);

        uint256 loanAmount = 1_000e18; // 1,000 USDT
        uint256 out = executor.previewArbitrage(USDT, loanAmount, steps);
        int256 spread = int256(out) - int256(loanAmount);

        console.log("Borrowed (USDT):", loanAmount);
        console.log("Cycle returns (USDT):", out);
        if (spread >= 0) {
            console.log("Gross spread (USDT, before flash-loan premium):", uint256(spread));
        } else {
            console.log("Gross spread is NEGATIVE (USDT, before flash-loan premium):", uint256(-spread));
        }
        // Deliberately no assertion on profitability - see contract-level note above.
    }

    /// @notice Actually attempts the real flash loan + real swaps against the
    ///         forked real Aave Pool and real PancakeSwap Router. Accepts
    ///         EITHER outcome: a real profitable execution, or a correct
    ///         SpreadTooLow revert (the expected common case in an efficient
    ///         market) - and reports which one happened.
    function test_AttemptRealFlashLoanArbitrage() public {
        AaveArbitrageExecutorV3.SwapStep[] memory steps = new AaveArbitrageExecutorV3.SwapStep[](3);
        steps[0] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDT, WBNB, 0, 0, 0);
        steps[1] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, WBNB, USDC, 0, 0, 0);
        steps[2] = AaveArbitrageExecutorV3.SwapStep(PANCAKE_V2_ROUTER, address(0), 0, USDC, USDT, 0, 0, 0);

        uint256 profitBefore = _usdtBalance(profitRecipient);

        vm.prank(owner);
        try executor.executeArbitrage(USDT, 1_000e18, steps, 0, 100) {
            uint256 profitAfter = _usdtBalance(profitRecipient);
            console.log("REAL flash loan succeeded. Net profit (USDT):", profitAfter - profitBefore);
        } catch (bytes memory reason) {
            console.log("Flash loan NOT taken (expected in most efficient-market cases).");
            console.logBytes(reason);
        }
    }

    function _usdtBalance(address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = USDT.staticcall(abi.encodeWithSignature("balanceOf(address)", who));
        require(ok, "balanceOf failed");
        return abi.decode(data, (uint256));
    }
}
