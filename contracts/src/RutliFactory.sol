// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {RutliAccount} from "./RutliAccount.sol";

/**
 * @title RutliFactory
 * @notice Deploys Rütli accounts as non-upgradeable EIP-1167 clones at deterministic addresses.
 *
 * The CREATE2 salt commits to the *whole* configuration (keys, delays, allowances) plus a user salt.
 * Consequences:
 *  - the wallet address is known before deployment (counterfactual: it can receive funds and the
 *    first UserOperation deploys it through `initCode`);
 *  - nobody can front-run the deployment with different keys: another configuration gives another address;
 *  - deployment and initialization happen in the same call, so there is no uninitialized window.
 */
contract RutliFactory {
    RutliAccount public immutable implementation;

    event AccountCreated(address indexed account, bytes32 indexed salt);

    constructor(RutliAccount implementation_) {
        implementation = implementation_;
    }

    /**
     * @notice Deploy (or return the already deployed) account for `cfg` and `userSalt`.
     * @dev Idempotent, as required by ERC-4337 factories.
     */
    function createAccount(RutliAccount.InitConfig calldata cfg, bytes32 userSalt) external returns (RutliAccount) {
        bytes32 salt = computeSalt(cfg, userSalt);
        address predicted = Clones.predictDeterministicAddress(address(implementation), salt);
        if (predicted.code.length != 0) return RutliAccount(payable(predicted));

        address account = Clones.cloneDeterministic(address(implementation), salt);
        RutliAccount(payable(account)).initialize(cfg);
        emit AccountCreated(account, salt);
        return RutliAccount(payable(account));
    }

    /// @notice Address that {createAccount} returns for these parameters.
    function getAddress(RutliAccount.InitConfig calldata cfg, bytes32 userSalt) external view returns (address) {
        return Clones.predictDeterministicAddress(address(implementation), computeSalt(cfg, userSalt));
    }

    function computeSalt(RutliAccount.InitConfig calldata cfg, bytes32 userSalt) public pure returns (bytes32) {
        return keccak256(abi.encode(cfg, userSalt));
    }
}
