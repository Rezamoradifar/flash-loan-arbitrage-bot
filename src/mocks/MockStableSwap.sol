// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Simplified Curve/Ellipsis-style stable pool: N tokens indexed 0..N-1,
///      near-1:1 pricing (constant-sum minus a small fee) rather than a full
///      StableSwap invariant — enough to exercise the executor's Stable-style
///      SwapStep (get_dy/exchange with int128 indices) without reimplementing
///      Curve's amplified-invariant math.
contract MockStableSwap {
    address[] public tokens;
    uint16 public immutable feeBPS;

    constructor(address[] memory _tokens, uint16 _feeBPS) {
        tokens = _tokens;
        feeBPS = _feeBPS;
    }

    function get_dy(int128 i, int128 j, uint256 dx) public view returns (uint256) {
        address tokenIn = tokens[uint128(i)];
        address tokenOut = tokens[uint128(j)];
        uint8 decIn = _decimals(tokenIn);
        uint8 decOut = _decimals(tokenOut);

        uint256 dxWad = decIn <= 18 ? dx * (10 ** (18 - decIn)) : dx / (10 ** (decIn - 18));
        uint256 dyWad = (dxWad * (10_000 - feeBPS)) / 10_000;
        return decOut <= 18 ? dyWad / (10 ** (18 - decOut)) : dyWad * (10 ** (decOut - 18));
    }

    function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256) {
        uint256 dy = get_dy(i, j, dx);
        require(dy >= min_dy, "MockStableSwap: slippage");

        address tokenIn = tokens[uint128(i)];
        address tokenOut = tokens[uint128(j)];
        IERC20(tokenIn).transferFrom(msg.sender, address(this), dx);
        IERC20(tokenOut).transfer(msg.sender, dy);
        return dy;
    }

    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok, "MockStableSwap: no decimals()");
        return abi.decode(data, (uint8));
    }
}
