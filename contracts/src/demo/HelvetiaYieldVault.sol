// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title HelvetiaYieldVault — DEMO ONLY
 * @notice Plain OpenZeppelin ERC-4626 vault standing in for an *approved* DeFi protocol (think a
 * regulated tokenized money-market fund). Yield is simulated by anyone donating assets to the vault.
 */
contract HelvetiaYieldVault is ERC4626 {
    constructor(IERC20 asset_) ERC20("Helvetia Yield Vault (demo)", "hyUSDC") ERC4626(asset_) {}

    /// @dev Virtual-share offset: protects the first depositor against the ERC-4626 inflation attack.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }
}
