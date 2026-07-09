// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Single-pair constant-product pool exposing both the QuoterV2-style
///      quoteExactInputSingle and the SwapRouter-style exactInputSingle on
///      the same contract (real PancakeSwap V3 splits these across separate
///      Quoter/Router contracts backed by the same pool state; here one
///      contract plays both roles for simplicity — the executor is given
///      this same address as both `router` and `quoter` in the SwapStep).
contract MockRouterV3 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

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

    function _reservesFor(address tokenIn, address tokenOut) internal view returns (uint256 rIn, uint256 rOut, bool inIsA) {
        if (tokenIn == tokenA && tokenOut == tokenB) {
            return (reserveA, reserveB, true);
        } else if (tokenIn == tokenB && tokenOut == tokenA) {
            return (reserveB, reserveA, false);
        }
        revert("MockRouterV3: bad pair");
    }

    function _amountOut(uint256 amountIn, uint256 rIn, uint256 rOut) internal view returns (uint256) {
        uint256 amountInWithFee = amountIn * (10_000 - feeBPS);
        uint256 numerator = amountInWithFee * rOut;
        uint256 denominator = rIn * 10_000 + amountInWithFee;
        return numerator / denominator;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        view
        returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)
    {
        (uint256 rIn, uint256 rOut, ) = _reservesFor(params.tokenIn, params.tokenOut);
        amountOut = _amountOut(params.amountIn, rIn, rOut);
        sqrtPriceX96After = 0;
        initializedTicksCrossed = 0;
        gasEstimate = 0;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        require(block.timestamp <= params.deadline, "MockRouterV3: expired");
        (uint256 rIn, uint256 rOut, bool inIsA) = _reservesFor(params.tokenIn, params.tokenOut);
        amountOut = _amountOut(params.amountIn, rIn, rOut);
        require(amountOut >= params.amountOutMinimum, "MockRouterV3: slippage");

        IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        if (inIsA) {
            reserveA += params.amountIn;
            reserveB -= amountOut;
        } else {
            reserveB += params.amountIn;
            reserveA -= amountOut;
        }
        IERC20(params.tokenOut).transfer(params.recipient, amountOut);
    }
}
