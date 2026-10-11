// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {EntryPoint} from "@account-abstraction/contracts/core/EntryPoint.sol";
import {IEntryPoint as AAEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IEntryPoint as OZEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";

import {RutliAccount} from "../../src/RutliAccount.sol";
import {RutliFactory} from "../../src/RutliFactory.sol";
import {RutliPaymaster} from "../../src/RutliPaymaster.sol";
import {MockUSDC} from "../../src/demo/MockUSDC.sol";

/**
 * Shared fixture: a real EntryPoint v0.8, the Rütli implementation/factory/paymaster, a test USDC,
 * and helpers that produce *real* signatures for every factor:
 *  - the passkey signs a genuine WebAuthn assertion (authenticatorData + clientDataJson, P-256),
 *  - card / co-signer / guardian sign the EIP-712 userOpHash with secp256k1.
 * Every user operation goes through `EntryPoint.handleOps`, exactly like on-chain.
 */
abstract contract RutliTestBase is Test {
    // P-256 group order, used to normalize `s` (OpenZeppelin rejects high-s signatures).
    uint256 internal constant P256_N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;

    uint8 internal constant P = 1; // passkey
    uint8 internal constant C = 2; // card
    uint8 internal constant S = 4; // Swissquote co-signer
    uint8 internal constant G = 8; // guardian

    uint32 internal constant MIN_DELAY = 1 hours;
    uint32 internal constant FREEZE_DURATION = 3 days;
    uint32 internal constant RECOVERY_DELAY = 7 days;
    uint32 internal constant EXIT_DELAY = 30 days;
    uint128 internal constant DAILY_USDC = 1_000e6;
    uint128 internal constant DAILY_ETH = 0.5 ether;

    EntryPoint internal entryPoint;
    RutliAccount internal implementation;
    RutliFactory internal factory;
    RutliPaymaster internal paymaster;
    MockUSDC internal usdc;

    // Keys. The passkey is a P-256 key; the others are secp256k1.
    uint256 internal passkeyPk = 0x1d7c1f3f8f1e4a6b9c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b;
    uint256 internal cardPk = 0xC0FFEE01;
    uint256 internal cosignerPk = 0x5150_0001;
    uint256 internal guardianPk = 0x9057_0001;
    uint256 internal sponsorPk = 0x6A5_0001;

    bytes32 internal passkeyX;
    bytes32 internal passkeyY;
    address internal cardAddr;
    address internal cosignerAddr;
    address internal guardianAddr;
    address internal sponsorAddr;

    address internal treasury = makeAddr("swissquote-treasury");
    address payable internal bundler = payable(makeAddr("bundler"));
    address internal bob = makeAddr("bob");
    address internal mallory = makeAddr("mallory");

    RutliAccount internal account;

    function setUp() public virtual {
        vm.warp(1_760_000_000);

        entryPoint = new EntryPoint();
        implementation = new RutliAccount(OZEntryPoint(address(entryPoint)), MIN_DELAY, FREEZE_DURATION);
        factory = new RutliFactory(implementation);
        usdc = new MockUSDC(treasury);

        (passkeyX, passkeyY) = _p256Public(passkeyPk);
        cardAddr = vm.addr(cardPk);
        cosignerAddr = vm.addr(cosignerPk);
        guardianAddr = vm.addr(guardianPk);
        sponsorAddr = vm.addr(sponsorPk);

        paymaster = new RutliPaymaster(AAEntryPoint(address(entryPoint)), treasury, sponsorAddr);
        vm.deal(treasury, 100 ether);
        vm.prank(treasury);
        paymaster.deposit{value: 10 ether}();

        account = factory.createAccount(_config(), bytes32(0));
        vm.prank(treasury);
        usdc.mint(address(account), 10_000e6);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Configuration
    // ─────────────────────────────────────────────────────────────────────────

    function _config() internal view returns (RutliAccount.InitConfig memory cfg) {
        address[] memory tokens = new address[](2);
        uint128[] memory limits = new uint128[](2);
        tokens[0] = address(usdc);
        limits[0] = DAILY_USDC;
        tokens[1] = address(0); // native ETH
        limits[1] = DAILY_ETH;
        cfg = RutliAccount.InitConfig({
            passkeyX: passkeyX,
            passkeyY: passkeyY,
            card: cardAddr,
            cosigner: cosignerAddr,
            guardian: guardianAddr,
            recoveryDelay: RECOVERY_DELAY,
            exitDelay: EXIT_DELAY,
            allowanceTokens: tokens,
            allowanceLimits: limits
        });
    }

    function _p256Public(uint256 pk) internal pure returns (bytes32 x, bytes32 y) {
        (uint256 px, uint256 py) = vm.publicKeyP256(pk);
        return (bytes32(px), bytes32(py));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // User operations
    // ─────────────────────────────────────────────────────────────────────────

    function _pack(uint256 high, uint256 low) internal pure returns (bytes32) {
        return bytes32((high << 128) | low);
    }

    function _baseOp(address sender, bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = sender;
        op.nonce = entryPoint.getNonce(sender, 0);
        op.initCode = "";
        op.callData = callData;
        op.accountGasLimits = _pack(3_000_000, 1_000_000); // verificationGasLimit | callGasLimit
        op.preVerificationGas = 60_000;
        op.gasFees = _pack(1 gwei, 2 gwei); // maxPriorityFeePerGas | maxFeePerGas
        op.paymasterAndData = "";
        op.signature = "";
    }

    /// @dev Attach a valid Swissquote sponsorship (gasless for the client).
    function _sponsor(PackedUserOperation memory op) internal view {
        _sponsorWith(op, sponsorPk, uint48(block.timestamp + 10 minutes), 0);
    }

    function _sponsorWith(PackedUserOperation memory op, uint256 signerPk, uint48 validUntil, uint48 validAfter)
        internal
        view
    {
        op.paymasterAndData =
            abi.encodePacked(address(paymaster), uint128(300_000), uint128(0), validUntil, validAfter, new bytes(65));
        bytes32 digest = paymaster.sponsorshipHash(op, validUntil, validAfter);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        op.paymasterAndData =
            abi.encodePacked(address(paymaster), uint128(300_000), uint128(0), validUntil, validAfter, r, s, v);
    }

    function _opHash(PackedUserOperation memory op) internal view returns (bytes32) {
        return entryPoint.getUserOpHash(op);
    }

    /// @dev Build, sponsor and sign (with the given factors) an operation on `account`.
    function _op(bytes memory callData, uint8 factors) internal view returns (PackedUserOperation memory op) {
        op = _opOn(address(account), callData, factors);
    }

    function _opOn(address sender, bytes memory callData, uint8 factors)
        internal
        view
        returns (PackedUserOperation memory op)
    {
        op = _baseOp(sender, callData);
        _sponsor(op);
        op.signature = _factorSignature(_opHash(op), factors);
    }

    function _handle(PackedUserOperation memory op) internal returns (bool success, bytes memory revertReason) {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.recordLogs();
        entryPoint.handleOps(ops, bundler);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool found;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter != address(entryPoint)) continue;
            if (logs[i].topics[0] == AAEntryPoint.UserOperationEvent.selector) {
                (, success,,) = abi.decode(logs[i].data, (uint256, bool, uint256, uint256));
                found = true;
            } else if (logs[i].topics[0] == AAEntryPoint.UserOperationRevertReason.selector) {
                (, revertReason) = abi.decode(logs[i].data, (uint256, bytes));
            }
        }
        require(found, "no UserOperationEvent");
    }

    /// @dev Sign with `factors` and execute; returns whether the inner call succeeded.
    function _run(bytes memory callData, uint8 factors) internal returns (bool success, bytes memory revertReason) {
        return _handle(_op(callData, factors));
    }

    function _runOk(bytes memory callData, uint8 factors) internal {
        (bool success, bytes memory reason) = _run(callData, factors);
        if (!success) {
            emit log_named_bytes("unexpected revert", reason);
            revert("operation reverted");
        }
    }

    /// @dev Expect the EntryPoint to reject the operation at validation (the pact refuses these factors).
    function _expectRefused(bytes memory callData, uint8 factors) internal {
        PackedUserOperation memory op = _op(callData, factors);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSelector(AAEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        entryPoint.handleOps(ops, bundler);
    }

    function _expectExecutionRevert(bytes memory callData, uint8 factors, bytes memory expectedReason) internal {
        (bool success, bytes memory reason) = _run(callData, factors);
        assertFalse(success, "operation should have reverted");
        assertEq(reason, expectedReason, "unexpected revert reason");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Factor signatures
    // ─────────────────────────────────────────────────────────────────────────

    /// @dev Encode the signature blob for `factors` (bitmask), each factor signing `hash`.
    function _factorSignature(bytes32 hash, uint8 factors) internal view returns (bytes memory) {
        return _factorSignatureWith(hash, factors, passkeyPk, cardPk, cosignerPk, guardianPk);
    }

    function _factorSignatureWith(bytes32 hash, uint8 factors, uint256 pPk, uint256 cPk, uint256 sPk, uint256 gPk)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory body;
        uint8 count;
        if (factors & P != 0) {
            body = _appendEntry(body, P, _webauthn(pPk, hash));
            ++count;
        }
        if (factors & C != 0) {
            body = _appendEntry(body, C, _ecdsa(cPk, hash));
            ++count;
        }
        if (factors & S != 0) {
            body = _appendEntry(body, S, _ecdsa(sPk, hash));
            ++count;
        }
        if (factors & G != 0) {
            body = _appendEntry(body, G, _ecdsa(gPk, hash));
            ++count;
        }
        return abi.encodePacked(count, body);
    }

    function _appendEntry(bytes memory body, uint8 factor, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodePacked(body, factor, uint16(data.length), data);
    }

    function _ecdsa(uint256 pk, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, hash);
        return abi.encodePacked(r, s, v);
    }

    /// @dev A real WebAuthn assertion as produced by a platform authenticator (UP + UV flags set).
    function _webauthn(uint256 pk, bytes32 challenge) internal pure returns (bytes memory) {
        return _webauthnWithFlags(pk, challenge, 0x05, true);
    }

    function _webauthnWithFlags(uint256 pk, bytes32 challenge, uint8 flags, bool normalizeS)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory authenticatorData = abi.encodePacked(sha256("localhost"), bytes1(flags), bytes4(0x00000001));
        string memory clientDataJson = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"http://localhost:5173","crossOrigin":false}'
        );
        bytes32 digest = sha256(abi.encodePacked(authenticatorData, sha256(bytes(clientDataJson))));
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        if (normalizeS && uint256(s) > P256_N / 2) s = bytes32(P256_N - uint256(s));
        if (!normalizeS && uint256(s) <= P256_N / 2) s = bytes32(P256_N - uint256(s)); // force high-s
        // challengeIndex = 23 ('"challenge"' position), typeIndex = 1 ('"type"' position)
        return abi.encode(r, s, uint256(23), uint256(1), authenticatorData, clientDataJson);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Call data shortcuts
    // ─────────────────────────────────────────────────────────────────────────

    function _spend(address token, address to, uint256 amount) internal pure returns (bytes memory) {
        return abi.encodeCall(RutliAccount.spend, (token, to, amount));
    }

    function _execute(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeCall(RutliAccount.execute, (target, value, data));
    }

    function _usdcTransfer(address to, uint256 amount) internal view returns (bytes memory) {
        return _execute(address(usdc), 0, abi.encodeCall(usdc.transfer, (to, amount)));
    }
}
