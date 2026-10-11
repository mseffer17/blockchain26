// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BasePaymaster} from "@account-abstraction/contracts/core/BasePaymaster.sol";
import {IEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {_packValidationData} from "@account-abstraction/contracts/core/Helpers.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/**
 * @title RutliPaymaster — Swissquote gas sponsorship
 * @notice Verifying paymaster: pays the gas of a UserOperation when Swissquote's sponsorship service has
 * signed it. Clients move USDC without ever holding ETH.
 *
 * Who pays: Swissquote, from this contract's deposit in the EntryPoint.
 * Abuse prevention (off-chain, in the gas-station service, before signing):
 *  - only accounts created through the Swissquote onboarding (registered clients),
 *  - monthly quota per account; security operations (freeze, recovery, cancellations) are always free,
 *  - only Rütli account functions, bounded gas limits, short signature validity.
 * On-chain, a sponsorship signature is bound to one exact UserOperation (sender, nonce, calldata, gas
 * limits and fees), to this paymaster, to this chain, and to a validity window.
 *
 * paymasterAndData layout (EntryPoint v0.8):
 *   [0:20]  paymaster address
 *   [20:36] paymasterVerificationGasLimit (uint128)
 *   [36:52] paymasterPostOpGasLimit (uint128)
 *   [52:58] validUntil (uint48)
 *   [58:64] validAfter (uint48)
 *   [64:129] signature (65 bytes)
 */
contract RutliPaymaster is BasePaymaster, EIP712 {
    bytes32 public constant SPONSORSHIP_TYPEHASH = keccak256(
        "Sponsorship(address sender,uint256 nonce,bytes32 initCodeHash,bytes32 callDataHash,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes32 paymasterGasLimits,uint48 validUntil,uint48 validAfter)"
    );

    uint256 private constant VALIDITY_OFFSET = PAYMASTER_DATA_OFFSET; // 52
    uint256 private constant SIGNATURE_OFFSET = VALIDITY_OFFSET + 12; // 64
    uint256 private constant PAYMASTER_AND_DATA_LENGTH = SIGNATURE_OFFSET + 65; // 129

    /// @notice Key of Swissquote's sponsorship service.
    address public signer;

    event SignerChanged(address indexed signer);

    error InvalidSigner();

    constructor(IEntryPoint entryPoint_, address owner_, address signer_)
        BasePaymaster(entryPoint_)
        EIP712("RutliPaymaster", "1")
    {
        if (signer_ == address(0)) revert InvalidSigner();
        signer = signer_;
        emit SignerChanged(signer_);
        if (owner_ != msg.sender) _transferOwnership(owner_);
    }

    /// @notice Rotate the sponsorship key (the treasury owner only).
    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert InvalidSigner();
        signer = newSigner;
        emit SignerChanged(newSigner);
    }

    /// @notice EIP-712 digest the sponsorship service signs for `userOp`.
    function sponsorshipHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        // Both paymaster gas limits (16 + 16 bytes) are covered by the signature.
        bytes32 paymasterGasLimits =
            bytes32(userOp.paymasterAndData[PAYMASTER_VALIDATION_GAS_OFFSET:PAYMASTER_DATA_OFFSET]);
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    SPONSORSHIP_TYPEHASH,
                    userOp.sender,
                    userOp.nonce,
                    keccak256(userOp.initCode),
                    keccak256(userOp.callData),
                    userOp.accountGasLimits,
                    userOp.preVerificationGas,
                    userOp.gasFees,
                    paymasterGasLimits,
                    validUntil,
                    validAfter
                )
            )
        );
    }

    function _validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256)
        internal
        view
        override
        returns (bytes memory context, uint256 validationData)
    {
        if (userOp.paymasterAndData.length != PAYMASTER_AND_DATA_LENGTH) {
            return ("", _packValidationData(true, 0, 0));
        }
        uint48 validUntil = uint48(bytes6(userOp.paymasterAndData[VALIDITY_OFFSET:VALIDITY_OFFSET + 6]));
        uint48 validAfter = uint48(bytes6(userOp.paymasterAndData[VALIDITY_OFFSET + 6:SIGNATURE_OFFSET]));
        bytes calldata signature = userOp.paymasterAndData[SIGNATURE_OFFSET:];

        (address recovered, ECDSA.RecoverError err,) =
            ECDSA.tryRecoverCalldata(sponsorshipHash(userOp, validUntil, validAfter), signature);
        // validUntil == 0 would mean "valid forever" to the EntryPoint: never accept an open-ended sponsorship.
        bool failed = err != ECDSA.RecoverError.NoError || recovered != signer || validUntil == 0;

        // Empty context: no postOp needed (pure sponsorship).
        return ("", _packValidationData(failed, validUntil, validAfter));
    }
}
