// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Single-pair constant-product AMM implementing just enough of the
///      Uniswap-V2 router interface (getAmountsOut / swapExactTokensForTokens
///      on a 2-hop path) for the executor's V2-style SwapStep to work against
///      it. One instance = one pair on one DEX, same as pointing the real
///      contract at PancakeSwap/Biswap/ApeSwap's real router per hop.
contract MockRouterV2 {
    address public immutable tokenA;
    address public immutable tokenB;
    uint256 public reserveA;
    uint256 public reserveB;
    uint16 public immutable feeBPS;

    constructor(address _tokenA, address _tokenB, uint256 _reserveA, uint256 _reserveB, uint16 _feeBPS) {
        tokenA = _tokenA;
        tokenB = _tokenB;
        reserveA = _reserveA;
        reserveB = _reserveB;
        feeBPS = _feeBPS;
    }

    /// @notice Adds test liquidity to this pool after deployment (pulls both
    ///         tokens from the caller via transferFrom - approve first).
    ///         Lets a test script/flow top up a pool without redeploying it,
    ///         mirroring a real router's addLiquidity step closely enough
    ///         for local arbitrage testing.
    function addLiquidity(uint256 amountA, uint256 amountB) external {
        IERC20(tokenA).transferFrom(msg.sender, address(this), amountA);
        IERC20(tokenB).transferFrom(msg.sender, address(this), amountB);
        reserveA += amountA;
        reserveB += amountB;
    }

    function _reservesFor(address tokenIn, address tokenOut) internal view returns (uint256 rIn, uint256 rOut, bool inIsA) {
        if (tokenIn == tokenA && tokenOut == tokenB) {
            return (reserveA, reserveB, true);
        } else if (tokenIn == tokenB && tokenOut == tokenA) {
            return (reserveB, reserveA, false);
        }
        revert("MockRouterV2: bad pair");
    }

    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut) internal view returns (uint256) {
        uint256 amountInWithFee = amountIn * (10_000 - feeBPS);
        uint256 numerator = amountInWithFee * rOut;
        uint256 denominator = rIn * 10_000 + amountInWithFee;
        return numerator / denominator;
    }

    function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts) {
        require(path.length == 2, "MockRouterV2: path len");
        (uint256 rIn, uint256 rOut, ) = _reservesFor(path[0], path[1]);
        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = _amountOut(amountIn, rIn, rOut);
    }

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts) {
        require(block.timestamp <= deadline, "MockRouterV2: expired");
        require(path.length == 2, "MockRouterV2: path len");
        (uint256 rIn, uint256 rOut, bool inIsA) = _reservesFor(path[0], path[1]);
        uint256 out = _amountOut(amountIn, rIn, rOut);
        require(out >= amountOutMin, "MockRouterV2: slippage");

        IERC20(path[0]).transferFrom(msg.sender, address(this), amountIn);
        if (inIsA) {
            reserveA += amountIn;
            reserveB -= out;
        } else {
            reserveB += amountIn;
            reserveA -= out;
        }
        IERC20(path[1]).transfer(to, out);

        amounts = new uint256[](2);
        amounts[0] = amountIn;
        amounts[1] = out;
    }
}
