// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {MockERC20} from "./MockERC20.sol";

/// @notice Test-only ERC-20 for local/testnet flash-swap and arbitrage
///         testing. NOT a real stablecoin: no USD peg, no reserve backing,
///         no claim of real-world value - it is a plain mintable token that
///         exists solely to exercise the executor's flash-loan, liquidity,
///         and profit-accounting logic against mock DEX pools. Never deploy
///         this (or anything resembling it) to mainnet as if it represented
///         real funds.
contract TestUSDT is MockERC20 {
    constructor() MockERC20("Test USDT", "tUSDT", 18) {}
}
