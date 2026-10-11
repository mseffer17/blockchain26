// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MockUSDC — DEMO ONLY
 * @notice 6-decimal test stablecoin used on local chains (and optionally on testnets) in place of USDC.
 * The owner plays the role of Swissquote's treasury: it mints to the bank's omnibus wallet.
 * On Base Sepolia the deployment script can use Circle's real test USDC instead.
 */
contract MockUSDC is ERC20, ERC20Permit, Ownable {
    constructor(address owner_)
        ERC20("USD Coin (Rutli test)", "USDC")
        ERC20Permit("USD Coin (Rutli test)")
        Ownable(owner_)
    {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }
}
