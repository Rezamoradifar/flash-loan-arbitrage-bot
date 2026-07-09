// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IFlashLoanSimpleReceiver {
    function executeOperation(address asset, uint256 amount, uint256 premium, address initiator, bytes calldata params)
        external
        returns (bool);
}

/// @dev Minimal stand-in for the real Aave V3 Pool's flashLoanSimple, close
///      enough to exercise the executor's borrow/callback/repay flow:
///      transfers `amount` up front, invokes the receiver's callback with the
///      real caller as `initiator` (mirroring Aave), then pulls back
///      `amount + premium` via the allowance the receiver approves inside the
///      callback. Reverts the whole flash loan if repayment isn't approved.
contract MockAavePool {
    uint256 public premiumBPS = 5; // 0.05%, matches Aave V3's current flashLoanSimple premium

    function setPremiumBPS(uint256 newPremiumBPS) external {
        premiumBPS = newPremiumBPS;
    }

    function fund(address asset, uint256 amount) external {
        IERC20(asset).transferFrom(msg.sender, address(this), amount);
    }

    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 /* referralCode */
    ) external {
        require(IERC20(asset).balanceOf(address(this)) >= amount, "MockAavePool: insufficient liquidity");
        uint256 premium = (amount * premiumBPS) / 10_000;

        IERC20(asset).transfer(receiverAddress, amount);

        bool ok = IFlashLoanSimpleReceiver(receiverAddress).executeOperation(asset, amount, premium, msg.sender, params);
        require(ok, "MockAavePool: callback returned false");

        IERC20(asset).transferFrom(receiverAddress, address(this), amount + premium);
    }
}
