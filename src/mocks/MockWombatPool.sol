// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Simplified Wombat-style asset-liability pool: near-1:1 pricing minus
///      a small haircut (fee), matching the real IPool.swap/quotePotentialSwap
///      signatures (verified against wombat-exchange/v1-core) closely enough
///      to exercise the executor's Wombat-style SwapStep without reimplementing
///      Wombat's full coverage-ratio invariant.
contract MockWombatPool {
    mapping(address => bool) public isTokenInPool;
    uint16 public immutable haircutBPS;

    constructor(address[] memory tokens, uint16 _haircutBPS) {
        for (uint256 i = 0; i < tokens.length; i++) {
            isTokenInPool[tokens[i]] = true;
        }
        haircutBPS = _haircutBPS;
    }

    function quotePotentialSwap(address fromToken, address toToken, int256 fromAmount)
        public
        view
        returns (uint256 potentialOutcome, uint256 haircut)
    {
        require(isTokenInPool[fromToken] && isTokenInPool[toToken], "MockWombatPool: unknown token");
        uint256 dx = uint256(fromAmount);
        uint8 decIn = _decimals(fromToken);
        uint8 decOut = _decimals(toToken);

        uint256 dxWad = decIn <= 18 ? dx * (10 ** (18 - decIn)) : dx / (10 ** (decIn - 18));
        haircut = (dxWad * haircutBPS) / 10_000;
        uint256 outWad = dxWad - haircut;
        potentialOutcome = decOut <= 18 ? outWad / (10 ** (18 - decOut)) : outWad * (10 ** (decOut - 18));
    }

    function swap(address fromToken, address toToken, uint256 fromAmount, uint256 minimumToAmount, address to, uint256 deadline)
        external
        returns (uint256 actualToAmount, uint256 haircut)
    {
        require(block.timestamp <= deadline, "MockWombatPool: expired");
        (actualToAmount, haircut) = quotePotentialSwap(fromToken, toToken, int256(fromAmount));
        require(actualToAmount >= minimumToAmount, "MockWombatPool: slippage");

        IERC20(fromToken).transferFrom(msg.sender, address(this), fromAmount);
        IERC20(toToken).transfer(to, actualToAmount);
    }

    function _decimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok, "MockWombatPool: no decimals()");
        return abi.decode(data, (uint8));
    }
}
