// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RutliTestBase} from "./utils/RutliTestBase.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IEntryPoint as AAEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {IEntryPoint as OZEntryPoint} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {RutliAccount} from "../src/RutliAccount.sol";

contract RutliAccountTest is RutliTestBase {
    // ═════════════════════════════════════════════════════════════════════════
    // Initialization
    // ═════════════════════════════════════════════════════════════════════════

    function test_Init_StoresConfiguration() public view {
        (bytes32 x, bytes32 y) = account.passkey();
        assertEq(x, passkeyX);
        assertEq(y, passkeyY);
        assertEq(account.card(), cardAddr);
        assertEq(account.cosigner(), cosignerAddr);
        assertEq(account.guardian(), guardianAddr);
        assertEq(account.recoveryDelay(), RECOVERY_DELAY);
        assertEq(account.exitDelay(), EXIT_DELAY);
        assertEq(address(account.entryPoint()), address(entryPoint));
        assertFalse(account.sovereign());
        (uint256 limit,, uint256 remaining,) = account.allowance(address(usdc));
        assertEq(limit, DAILY_USDC);
        assertEq(remaining, DAILY_USDC);
        assertEq(account.allowanceTokens().length, 2);
    }

    function test_Init_CannotBeCalledTwice() public {
        RutliAccount.InitConfig memory cfg = _config();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        account.initialize(cfg);
    }

    function test_Init_ImplementationIsLocked() public {
        RutliAccount.InitConfig memory cfg = _config();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        implementation.initialize(cfg);
    }

    function test_Init_RejectsInvalidPasskey() public {
        RutliAccount.InitConfig memory cfg = _config();
        cfg.passkeyY = bytes32(uint256(cfg.passkeyY) ^ 1); // not on the curve
        vm.expectRevert(RutliAccount.InvalidPasskey.selector);
        factory.createAccount(cfg, bytes32(uint256(1)));
    }

    function test_Init_RejectsDuplicateKeys() public {
        RutliAccount.InitConfig memory cfg = _config();
        cfg.guardian = cfg.cosigner; // one key must never count as two factors
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.DuplicateKey.selector, cfg.cosigner));
        factory.createAccount(cfg, bytes32(uint256(1)));

        cfg = _config();
        cfg.cosigner = cfg.card;
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.DuplicateKey.selector, cfg.card));
        factory.createAccount(cfg, bytes32(uint256(2)));
    }

    function test_Init_RejectsMissingCard() public {
        RutliAccount.InitConfig memory cfg = _config();
        cfg.card = address(0);
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.InvalidAddress.selector, address(0)));
        factory.createAccount(cfg, bytes32(uint256(1)));
    }

    function test_Init_RejectsDelaysOutOfBounds() public {
        RutliAccount.InitConfig memory cfg = _config();
        cfg.recoveryDelay = MIN_DELAY - 1;
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.DelayOutOfBounds.selector, MIN_DELAY - 1));
        factory.createAccount(cfg, bytes32(uint256(1)));

        cfg = _config();
        cfg.exitDelay = 366 days;
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.DelayOutOfBounds.selector, uint256(366 days)));
        factory.createAccount(cfg, bytes32(uint256(2)));
    }

    function test_Constructor_RejectsBadArgs() public {
        vm.expectRevert(RutliAccount.InvalidConstructorArgs.selector);
        new RutliAccount(OZEntryPoint(address(0)), MIN_DELAY, FREEZE_DURATION);
        vm.expectRevert(RutliAccount.InvalidConstructorArgs.selector);
        new RutliAccount(OZEntryPoint(address(entryPoint)), 0, FREEZE_DURATION);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Porte-monnaie: passkey alone, daily allowance, gasless
    // ═════════════════════════════════════════════════════════════════════════

    function test_Spend_PasskeyAloneWithinAllowance_Gasless() public {
        uint256 depositBefore = paymaster.getDeposit();
        _runOk(_spend(address(usdc), bob, 120e6), P);

        assertEq(usdc.balanceOf(bob), 120e6);
        assertEq(address(account).balance, 0, "client never needed ETH");
        assertLt(paymaster.getDeposit(), depositBefore, "Swissquote paid the gas");
        (, uint256 spent, uint256 remaining,) = account.allowance(address(usdc));
        assertEq(spent, 120e6);
        assertEq(remaining, DAILY_USDC - 120e6);
    }

    function test_Spend_NativeEth() public {
        vm.deal(address(account), 1 ether);
        _runOk(_spend(address(0), bob, 0.2 ether), P);
        assertEq(bob.balance, 0.2 ether);
    }

    function test_Spend_ExceedingAllowanceReverts() public {
        _runOk(_spend(address(usdc), bob, 900e6), P);
        _expectExecutionRevert(
            _spend(address(usdc), bob, 200e6),
            P,
            abi.encodeWithSelector(RutliAccount.AllowanceExceeded.selector, address(usdc), 200e6, 100e6)
        );
        assertEq(usdc.balanceOf(bob), 900e6);
    }

    function test_Spend_WindowResetsAfterOneDay() public {
        _runOk(_spend(address(usdc), bob, DAILY_USDC), P);
        _expectExecutionRevert(
            _spend(address(usdc), bob, 1),
            P,
            abi.encodeWithSelector(RutliAccount.AllowanceExceeded.selector, address(usdc), 1, 0)
        );
        vm.warp(block.timestamp + 1 days);
        _runOk(_spend(address(usdc), bob, DAILY_USDC), P);
        assertEq(usdc.balanceOf(bob), 2 * uint256(DAILY_USDC));
    }

    function test_Spend_TokenWithoutAllowanceReverts() public {
        address randomToken = makeAddr("random-token");
        _expectExecutionRevert(
            _spend(randomToken, bob, 1), P, abi.encodeWithSelector(RutliAccount.NoAllowance.selector, randomToken)
        );
    }

    function test_Spend_RejectsSelfAndZeroRecipient() public {
        _expectExecutionRevert(
            _spend(address(usdc), address(account), 1),
            P,
            abi.encodeWithSelector(RutliAccount.InvalidAddress.selector, address(account))
        );
        _expectExecutionRevert(
            _spend(address(usdc), address(0), 1),
            P,
            abi.encodeWithSelector(RutliAccount.InvalidAddress.selector, address(0))
        );
    }

    function testFuzz_Spend_NeverExceedsAllowance(uint96[5] memory amounts) public {
        uint256 total;
        for (uint256 i = 0; i < amounts.length; ++i) {
            uint256 amount = bound(uint256(amounts[i]), 1, 800e6);
            (bool ok,) = _run(_spend(address(usdc), bob, amount), P);
            if (ok) total += amount;
            assertLe(total, DAILY_USDC);
            assertEq(usdc.balanceOf(bob), total);
        }
    }

    function test_Spend_DirectCallIsRejected() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.Unauthorized.selector, mallory));
        account.spend(address(usdc), mallory, 1);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Coffre: two factors for arbitrary calls
    // ═════════════════════════════════════════════════════════════════════════

    function test_Execute_PasskeyAndCosigner() public {
        _runOk(_usdcTransfer(bob, 5_000e6), P | S);
        assertEq(usdc.balanceOf(bob), 5_000e6);
    }

    function test_Execute_PasskeyAndCard_WithoutSwissquote() public {
        _runOk(_usdcTransfer(bob, 5_000e6), P | C);
        assertEq(usdc.balanceOf(bob), 5_000e6);
    }

    function test_Execute_AllThreeFactorsAlsoWork() public {
        _runOk(_usdcTransfer(bob, 1e6), P | C | S);
        assertEq(usdc.balanceOf(bob), 1e6);
    }

    function test_Execute_RefusedForEveryInsufficientFactorSet() public {
        bytes memory callData = _usdcTransfer(mallory, 5_000e6);
        _expectRefused(callData, P); // stolen phone alone
        _expectRefused(callData, C); // stolen card alone
        _expectRefused(callData, S); // Swissquote alone
        _expectRefused(callData, G); // guardian alone
        _expectRefused(callData, S | G); // Swissquote + guardian together
        _expectRefused(callData, C | S); // card + Swissquote may only replace the passkey
        _expectRefused(callData, C | G);
        _expectRefused(callData, C | S | G);
        assertEq(usdc.balanceOf(mallory), 0);
    }

    function test_Execute_SelfCallIsForbidden() public {
        // P+S must not reach setGuardian (reserved to P+C) by routing a call through execute.
        bytes memory inner = abi.encodeCall(RutliAccount.setGuardian, (mallory));
        _expectExecutionRevert(
            _execute(address(account), 0, inner), P | S, abi.encodeWithSelector(RutliAccount.SelfCallForbidden.selector)
        );
        assertEq(account.guardian(), guardianAddr);
    }

    function test_ExecuteBatch_IsAtomic() public {
        RutliAccount.Call[] memory calls = new RutliAccount.Call[](2);
        calls[0] = RutliAccount.Call(address(usdc), 0, abi.encodeCall(usdc.transfer, (bob, 100e6)));
        calls[1] = RutliAccount.Call(address(usdc), 0, abi.encodeCall(usdc.transfer, (bob, 1_000_000e6))); // too much
        (bool ok,) = _run(abi.encodeCall(RutliAccount.executeBatch, (calls)), P | S);
        assertFalse(ok);
        assertEq(usdc.balanceOf(bob), 0, "first transfer rolled back");
    }

    function test_Execute_BubblesRevertReason() public {
        bytes memory inner = abi.encodeCall(usdc.transfer, (bob, 1_000_000e6));
        (bool ok, bytes memory reason) = _run(_execute(address(usdc), 0, inner), P | C);
        assertFalse(ok);
        // forge-lint: disable-next-line(unsafe-typecast) first 4 bytes = custom error selector
        assertEq(bytes4(reason), bytes4(keccak256("ERC20InsufficientBalance(address,uint256,uint256)")));
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Signature blob hardening
    // ═════════════════════════════════════════════════════════════════════════

    function _expectSignatureRejected(bytes memory signature) internal {
        PackedUserOperation memory op = _baseOp(address(account), _usdcTransfer(bob, 1e6));
        _sponsor(op);
        op.signature = signature;
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSelector(AAEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        entryPoint.handleOps(ops, bundler);
    }

    function _hashOfNextOp() internal view returns (bytes32) {
        PackedUserOperation memory op = _baseOp(address(account), _usdcTransfer(bob, 1e6));
        _sponsor(op);
        return _opHash(op);
    }

    function test_Signature_RejectsDuplicatedFactor() public {
        bytes32 h = _hashOfNextOp();
        bytes memory sSig = _ecdsa(cosignerPk, h);
        // The same co-signer signature twice must not count as two factors (and P is missing).
        bytes memory blob = abi.encodePacked(uint8(2), S, uint16(65), sSig, S, uint16(65), sSig);
        _expectSignatureRejected(blob);
    }

    function test_Signature_RejectsKeyUsedUnderAnotherFactor() public {
        bytes32 h = _hashOfNextOp();
        // The co-signer's signature presented as the CARD factor: recovers to the wrong address.
        bytes memory blob = abi.encodePacked(
            uint8(2),
            P,
            uint16(_webauthn(passkeyPk, h).length),
            _webauthn(passkeyPk, h),
            C,
            uint16(65),
            _ecdsa(cosignerPk, h)
        );
        _expectSignatureRejected(blob);
    }

    function test_Signature_RejectsTrailingBytes() public {
        bytes32 h = _hashOfNextOp();
        _expectSignatureRejected(abi.encodePacked(_factorSignature(h, P | S), hex"00"));
    }

    function test_Signature_RejectsUnknownOrCompositeFactorId() public {
        bytes32 h = _hashOfNextOp();
        bytes memory sSig = _ecdsa(cosignerPk, h);
        _expectSignatureRejected(abi.encodePacked(uint8(1), uint8(16), uint16(65), sSig));
        _expectSignatureRejected(abi.encodePacked(uint8(1), uint8(P | S), uint16(65), sSig));
    }

    function test_Signature_RejectsTruncatedAndEmptyBlobs() public {
        bytes32 h = _hashOfNextOp();
        bytes memory good = _factorSignature(h, P | S);
        bytes memory truncated = new bytes(good.length - 1);
        for (uint256 i = 0; i < truncated.length; ++i) {
            truncated[i] = good[i];
        }
        _expectSignatureRejected(truncated);
        _expectSignatureRejected("");
        _expectSignatureRejected(hex"00");
        _expectSignatureRejected(hex"05010000"); // count > 4
    }

    function test_Signature_RejectsSignatureOfAnotherOperation() public {
        bytes32 otherHash = keccak256("another operation");
        _expectSignatureRejected(_factorSignature(otherHash, P | S));
    }

    function test_Signature_RejectsWrongPasskey() public {
        bytes32 h = _hashOfNextOp();
        uint256 attackerPasskey = 0xBADBADBADBAD;
        _expectSignatureRejected(_factorSignatureWith(h, P | S, attackerPasskey, cardPk, cosignerPk, guardianPk));
    }

    function test_Signature_RejectsHighSPasskeySignature() public {
        bytes32 h = _hashOfNextOp();
        bytes memory highS = _webauthnWithFlags(passkeyPk, h, 0x05, false);
        bytes memory blob =
            abi.encodePacked(uint8(2), P, uint16(highS.length), highS, S, uint16(65), _ecdsa(cosignerPk, h));
        _expectSignatureRejected(blob);
    }

    function test_Signature_RejectsPasskeyWithoutUserVerification() public {
        bytes32 h = _hashOfNextOp();
        bytes memory noUv = _webauthnWithFlags(passkeyPk, h, 0x01, true); // UP only: no Face ID / PIN
        bytes memory blob =
            abi.encodePacked(uint8(2), P, uint16(noUv.length), noUv, S, uint16(65), _ecdsa(cosignerPk, h));
        _expectSignatureRejected(blob);
    }

    function test_Signature_UnknownSelectorIsDenied() public {
        // executeUserOp (IAccountExecute) is not part of the pact: default deny, even with every factor.
        _expectRefused(
            abi.encodeWithSelector(
                bytes4(
                    keccak256(
                        "executeUserOp((address,uint256,bytes,bytes,bytes32,uint256,bytes32,bytes,bytes),bytes32)"
                    )
                ),
                ""
            ),
            P | C | S | G
        );
        _expectRefused(hex"aabb", P | C | S); // shorter than a selector
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Key rotation
    // ═════════════════════════════════════════════════════════════════════════

    function test_RotatePasskey_CardAndCosigner_LostPhone() public {
        uint256 newPasskeyPk = 0xBEEF1234;
        (bytes32 nx, bytes32 ny) = _p256Public(newPasskeyPk);
        uint64 epochBefore = account.securityEpoch();

        _runOk(abi.encodeCall(RutliAccount.rotatePasskey, (nx, ny)), C | S);

        (bytes32 x, bytes32 y) = account.passkey();
        assertEq(x, nx);
        assertEq(y, ny);
        assertEq(account.securityEpoch(), epochBefore + 1);

        // The thief's old passkey is now worthless.
        _expectRefusedWithPasskey(_spend(address(usdc), mallory, 1e6), passkeyPk);
        // The new phone works.
        PackedUserOperation memory op = _baseOp(address(account), _spend(address(usdc), bob, 1e6));
        _sponsor(op);
        op.signature = _factorSignatureWith(_opHash(op), P, newPasskeyPk, cardPk, cosignerPk, guardianPk);
        (bool ok,) = _handle(op);
        assertTrue(ok);
    }

    function _expectRefusedWithPasskey(bytes memory callData, uint256 pk) internal {
        PackedUserOperation memory op = _baseOp(address(account), callData);
        _sponsor(op);
        op.signature = _factorSignatureWith(_opHash(op), P, pk, cardPk, cosignerPk, guardianPk);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSelector(AAEntryPoint.FailedOp.selector, 0, "AA24 signature error"));
        entryPoint.handleOps(ops, bundler);
    }

    function test_RotatePasskey_RefusedForSingleFactorsAndSwissquotePlusGuardian() public {
        (bytes32 nx, bytes32 ny) = _p256Public(0xBEEF1234);
        bytes memory callData = abi.encodeCall(RutliAccount.rotatePasskey, (nx, ny));
        _expectRefused(callData, P);
        _expectRefused(callData, C);
        _expectRefused(callData, S);
        _expectRefused(callData, S | G);
    }

    function test_RotatePasskey_RejectsInvalidKey() public {
        _expectExecutionRevert(
            abi.encodeCall(RutliAccount.rotatePasskey, (bytes32(uint256(1)), bytes32(uint256(2)))),
            C | S,
            abi.encodeWithSelector(RutliAccount.InvalidPasskey.selector)
        );
    }

    function test_RotateCard_PasskeyAndCosigner_LostCard() public {
        address newCard = makeAddr("new-card");
        _runOk(abi.encodeCall(RutliAccount.rotateCard, (newCard)), P | S);
        assertEq(account.card(), newCard);
        // C|S can no longer sign with the old card.
        (bytes32 nx, bytes32 ny) = _p256Public(0xBEEF1234);
        _expectRefused(abi.encodeCall(RutliAccount.rotatePasskey, (nx, ny)), C | S);
    }

    function test_RotateCard_CannotReuseAnotherFactorKey() public {
        _expectExecutionRevert(
            abi.encodeCall(RutliAccount.rotateCard, (cosignerAddr)),
            P | S,
            abi.encodeWithSelector(RutliAccount.DuplicateKey.selector, cosignerAddr)
        );
    }

    function test_SetGuardian_RequiresPasskeyAndCard() public {
        address newGuardian = makeAddr("notary");
        _expectRefused(abi.encodeCall(RutliAccount.setGuardian, (newGuardian)), P | S);
        _runOk(abi.encodeCall(RutliAccount.setGuardian, (newGuardian)), P | C);
        assertEq(account.guardian(), newGuardian);
    }

    function test_SetAllowance_RequiresPasskeyAndCard() public {
        bytes memory callData = abi.encodeCall(RutliAccount.setAllowance, (address(usdc), uint128(1_000_000e6)));
        _expectRefused(callData, P); // a phone thief cannot raise his own limit
        _expectRefused(callData, P | S); // nor with Swissquote's help
        _runOk(callData, P | C);
        (uint256 limit,,,) = account.allowance(address(usdc));
        assertEq(limit, 1_000_000e6);
    }

    function test_SetAllowance_LimitsNumberOfTokens() public {
        for (uint256 i = 0; i < 6; ++i) {
            address token = makeAddr(string.concat("token-", vm.toString(i)));
            _runOk(abi.encodeCall(RutliAccount.setAllowance, (token, uint128(1))), P | C);
        }
        _expectExecutionRevert(
            abi.encodeCall(RutliAccount.setAllowance, (address(0x2000), uint128(1))),
            P | C,
            abi.encodeWithSelector(RutliAccount.TooManyAllowanceTokens.selector)
        );
    }

    function test_SetDelays_Bounds() public {
        _expectExecutionRevert(
            abi.encodeCall(RutliAccount.setDelays, (MIN_DELAY - 1, EXIT_DELAY)),
            P | C,
            abi.encodeWithSelector(RutliAccount.DelayOutOfBounds.selector, MIN_DELAY - 1)
        );
        _expectRefused(abi.encodeCall(RutliAccount.setDelays, (MIN_DELAY, MIN_DELAY)), P | S);
        _runOk(abi.encodeCall(RutliAccount.setDelays, (2 days, 40 days)), P | C);
        assertEq(account.recoveryDelay(), 2 days);
        assertEq(account.exitDelay(), 40 days);
    }

    function test_SetCosigner_KeyRotationWithClientConsent() public {
        address newCosigner = makeAddr("sq-hsm-2026");
        _expectRefused(abi.encodeCall(RutliAccount.setCosigner, (newCosigner)), S | G);
        _runOk(abi.encodeCall(RutliAccount.setCosigner, (newCosigner)), P | S);
        assertEq(account.cosigner(), newCosigner);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Freeze
    // ═════════════════════════════════════════════════════════════════════════

    function test_Freeze_AnySingleNonPasskeyFactor() public {
        _runOk(abi.encodeCall(RutliAccount.freeze, ()), S);
        assertTrue(account.isFrozen());
        _runOk(abi.encodeCall(RutliAccount.freeze, ()), G);
        _runOk(abi.encodeCall(RutliAccount.freeze, ()), C);
        assertEq(account.frozenUntil(), block.timestamp + FREEZE_DURATION);
        _expectRefused(abi.encodeCall(RutliAccount.freeze, ()), P);
    }

    function test_Freeze_BlocksPasskeyOnlySpending() public {
        _runOk(abi.encodeCall(RutliAccount.freeze, ()), S); // client called the hotline
        _expectExecutionRevert(
            _spend(address(usdc), mallory, 1e6),
            P,
            abi.encodeWithSelector(RutliAccount.AccountFrozen.selector, uint64(block.timestamp + FREEZE_DURATION))
        );
        // ... but the client keeps full control with passkey + card (no lock-out).
        _runOk(_usdcTransfer(bob, 1e6), P | C);
    }

    function test_Freeze_Expires() public {
        _runOk(abi.encodeCall(RutliAccount.freeze, ()), S);
        vm.warp(block.timestamp + FREEZE_DURATION);
        _runOk(_spend(address(usdc), bob, 1e6), P);
    }

    function test_Unfreeze_RequiresPasskeyAndCard() public {
        _runOk(abi.encodeCall(RutliAccount.freeze, ()), C);
        _expectRefused(abi.encodeCall(RutliAccount.unfreeze, ()), P | S);
        _runOk(abi.encodeCall(RutliAccount.unfreeze, ()), P | C);
        assertFalse(account.isFrozen());
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Recovery: Swissquote + guardian, delayed, cancellable by the client
    // ═════════════════════════════════════════════════════════════════════════

    function _initiateRecovery(uint256 newPasskeyPk, address newCard) internal returns (bytes32 nx, bytes32 ny) {
        (nx, ny) = _p256Public(newPasskeyPk);
        _runOk(abi.encodeCall(RutliAccount.initiateRecovery, (nx, ny, newCard, keccak256("LOST_ALL"))), S | G);
    }

    function test_Recovery_SwissquoteAndGuardian_AfterDelay() public {
        uint256 newPasskeyPk = 0xFEED5678;
        address newCard = makeAddr("new-card");
        (bytes32 nx, bytes32 ny) = _initiateRecovery(newPasskeyPk, newCard);

        RutliAccount.PendingRecovery memory r = account.pendingRecovery();
        assertEq(r.executeAfter, block.timestamp + RECOVERY_DELAY);
        assertEq(r.newCard, newCard);

        vm.expectRevert(abi.encodeWithSelector(RutliAccount.NotReady.selector, r.executeAfter));
        account.finalizeRecovery();

        vm.warp(r.executeAfter);
        vm.prank(makeAddr("anyone"));
        account.finalizeRecovery();

        (bytes32 x, bytes32 y) = account.passkey();
        assertEq(x, nx);
        assertEq(y, ny);
        assertEq(account.card(), newCard);
        assertEq(account.pendingRecovery().executeAfter, 0);
        _expectRefusedWithPasskey(_spend(address(usdc), mallory, 1e6), passkeyPk); // old phone is dead
    }

    function test_Recovery_CannotMoveFundsDuringTheDelay() public {
        _initiateRecovery(0xFEED5678, makeAddr("new-card"));
        _expectRefused(_usdcTransfer(mallory, 1e6), S | G);
        _expectRefused(_spend(address(usdc), mallory, 1e6), S | G);
    }

    function test_Recovery_ClientCancelsWithPasskey() public {
        _initiateRecovery(0xFEED5678, makeAddr("new-card"));
        _runOk(abi.encodeCall(RutliAccount.cancelRecovery, ()), P); // one Face ID is enough
        assertEq(account.pendingRecovery().executeAfter, 0);
        vm.warp(block.timestamp + RECOVERY_DELAY);
        vm.expectRevert(RutliAccount.NothingPending.selector);
        account.finalizeRecovery();
    }

    function test_Recovery_ClientCancelsWithCard() public {
        _initiateRecovery(0xFEED5678, makeAddr("new-card"));
        _runOk(abi.encodeCall(RutliAccount.cancelRecovery, ()), C);
        assertEq(account.pendingRecovery().executeAfter, 0);
    }

    function test_Recovery_CardCancelsDirectly_WithoutAnyInfrastructure() public {
        // Swissquote and the guardian collude and refuse to relay the client's cancellation:
        // the card sends a plain transaction from its own address.
        _initiateRecovery(0xFEED5678, makeAddr("new-card"));
        vm.prank(cardAddr);
        account.cancelRecovery();
        assertEq(account.pendingRecovery().executeAfter, 0);
    }

    function test_ProtectiveDirectCalls_OnlyByTheCard() public {
        _initiateRecovery(0xFEED5678, makeAddr("new-card"));
        vm.startPrank(mallory);
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.Unauthorized.selector, mallory));
        account.cancelRecovery();
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.Unauthorized.selector, mallory));
        account.freeze();
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.Unauthorized.selector, mallory));
        account.cancelExit();
        vm.stopPrank();
        vm.prank(cosignerAddr); // institutions have no direct-call path at all
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.Unauthorized.selector, cosignerAddr));
        account.cancelRecovery();

        vm.prank(cardAddr);
        account.freeze();
        assertTrue(account.isFrozen());
    }

    function test_Recovery_SwissquoteAndGuardianCannotCancelOrRestartWithoutTheDelay() public {
        _initiateRecovery(0xFEED5678, makeAddr("new-card"));
        _expectRefused(abi.encodeCall(RutliAccount.cancelRecovery, ()), S | G);
        // Re-initiating restarts the clock; it never shortens it.
        vm.warp(block.timestamp + 3 days);
        _initiateRecovery(0xFEED5678, makeAddr("new-card"));
        assertEq(account.pendingRecovery().executeAfter, block.timestamp + RECOVERY_DELAY);
    }

    function test_Recovery_SingleInstitutionCannotInitiate() public {
        (bytes32 nx, bytes32 ny) = _p256Public(0xFEED5678);
        bytes memory callData = abi.encodeCall(RutliAccount.initiateRecovery, (nx, ny, makeAddr("c"), bytes32(0)));
        _expectRefused(callData, S);
        _expectRefused(callData, G);
        _expectRefused(callData, P | C); // the client uses rotate* instead
    }

    function test_Recovery_VoidedByAnyKeyChange() public {
        _initiateRecovery(0xFEED5678, makeAddr("new-card"));
        (bytes32 nx, bytes32 ny) = _p256Public(0xABCDEF);
        _runOk(abi.encodeCall(RutliAccount.rotatePasskey, (nx, ny)), C | S); // the client found her card
        assertEq(account.pendingRecovery().executeAfter, 0);
        vm.warp(block.timestamp + RECOVERY_DELAY);
        vm.expectRevert(RutliAccount.NothingPending.selector);
        account.finalizeRecovery();
    }

    function test_Recovery_Inheritance_ReasonHashIsRecorded() public {
        (bytes32 nx, bytes32 ny) = _p256Public(0x4E1125);
        bytes32 evidence = keccak256("certificate of inheritance #2026-LS-1234 (art. 559 CC)");
        _runOk(abi.encodeCall(RutliAccount.initiateRecovery, (nx, ny, makeAddr("heir-card"), evidence)), S | G);
        assertEq(account.pendingRecovery().reasonHash, evidence);
    }

    // ═════════════════════════════════════════════════════════════════════════
    // Exit: the card alone, delayed, no Swissquote infrastructure required
    // ═════════════════════════════════════════════════════════════════════════

    function test_Exit_CardOnly_WithoutAnyInfrastructure() public {
        // Swissquote is gone: no bundler, no paymaster, no website. The card sends plain transactions.
        vm.deal(cardAddr, 0.01 ether);
        vm.prank(cardAddr);
        account.initiateExit();
        RutliAccount.PendingExit memory e = account.pendingExit();
        assertEq(e.executeAfter, block.timestamp + EXIT_DELAY);

        vm.expectRevert(abi.encodeWithSelector(RutliAccount.NotReady.selector, e.executeAfter));
        account.finalizeExit();

        vm.warp(e.executeAfter);
        account.finalizeExit();
        assertTrue(account.sovereign());
        assertEq(account.cosigner(), address(0));
        assertEq(account.guardian(), address(0));

        // The card alone now has full control and sweeps the funds to a new wallet.
        address newWallet = makeAddr("claire-new-wallet");
        uint256 balance = usdc.balanceOf(address(account));
        vm.prank(cardAddr);
        account.execute(address(usdc), 0, abi.encodeCall(usdc.transfer, (newWallet, balance)));
        assertEq(usdc.balanceOf(newWallet), balance);
    }

    function test_Exit_ThroughEntryPointWithCard() public {
        _runOk(abi.encodeCall(RutliAccount.initiateExit, ()), C);
        assertGt(account.pendingExit().executeAfter, 0);
    }

    function test_Exit_StrangerCannotInitiate() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.Unauthorized.selector, mallory));
        account.initiateExit();
        _expectRefused(abi.encodeCall(RutliAccount.initiateExit, ()), S | G);
        _expectRefused(abi.encodeCall(RutliAccount.initiateExit, ()), P);
    }

    function test_Exit_StolenCard_ClientCancelsWithPasskey() public {
        vm.prank(cardAddr); // a burglar found the card
        account.initiateExit();
        _runOk(abi.encodeCall(RutliAccount.cancelExit, ()), P);
        assertEq(account.pendingExit().executeAfter, 0);
    }

    function test_Exit_SwissquoteCannotBlockIt() public {
        vm.prank(cardAddr);
        account.initiateExit();
        _expectRefused(abi.encodeCall(RutliAccount.cancelExit, ()), S);
        _expectRefused(abi.encodeCall(RutliAccount.cancelExit, ()), S | G);
        vm.warp(block.timestamp + EXIT_DELAY);
        account.finalizeExit();
        assertTrue(account.sovereign());
    }

    function test_Exit_StaleAfterCardRotation() public {
        vm.prank(cardAddr);
        account.initiateExit();
        _runOk(abi.encodeCall(RutliAccount.rotateCard, (makeAddr("new-card"))), P | S);
        assertEq(account.pendingExit().executeAfter, 0, "stolen-card exit voided");
        vm.prank(cardAddr);
        vm.expectRevert(abi.encodeWithSelector(RutliAccount.Unauthorized.selector, cardAddr));
        account.initiateExit();
    }

    function test_Exit_SovereignMode_RulesChange() public {
        vm.prank(cardAddr);
        account.initiateExit();
        vm.warp(block.timestamp + EXIT_DELAY);
        account.finalizeExit();

        // Card alone through the EntryPoint is now full authority.
        _runOk(_usdcTransfer(bob, 10e6), C);
        // No route back for Swissquote: the co-signer is gone and cannot be re-added.
        _expectExecutionRevert(
            abi.encodeCall(RutliAccount.setCosigner, (cosignerAddr)),
            C,
            abi.encodeWithSelector(RutliAccount.SovereignMode.selector)
        );
        vm.prank(cardAddr);
        vm.expectRevert(RutliAccount.SovereignMode.selector);
        account.initiateExit();
        // The passkey keeps its daily allowance.
        _runOk(_spend(address(usdc), bob, 1e6), P);
    }

    function test_RecoveryFinalization_VoidsPendingExit() public {
        vm.prank(cardAddr); // thief with the card starts an exit (30 days)...
        account.initiateExit();
        _initiateRecovery(0xFEED5678, makeAddr("new-card")); // ...the client lost everything else (7 days)
        vm.warp(block.timestamp + RECOVERY_DELAY);
        account.finalizeRecovery();
        assertEq(account.pendingExit().executeAfter, 0);
        vm.warp(block.timestamp + EXIT_DELAY);
        vm.expectRevert(RutliAccount.NothingPending.selector);
        account.finalizeExit();
    }

    // ═════════════════════════════════════════════════════════════════════════
    // ERC-1271
    // ═════════════════════════════════════════════════════════════════════════

    function test_ERC1271_RequiresFullAuthority() public view {
        bytes32 message = keccak256("I authorize ...");
        bytes32 h = account.replaySafeHash(message);
        assertEq(account.isValidSignature(message, _factorSignature(h, P)), bytes4(0xffffffff), "passkey alone");
        assertEq(account.isValidSignature(message, _factorSignature(h, S | G)), bytes4(0xffffffff), "institutions");
        assertEq(account.isValidSignature(message, _factorSignature(h, P | S)), IERC1271.isValidSignature.selector);
        assertEq(account.isValidSignature(message, _factorSignature(h, P | C)), IERC1271.isValidSignature.selector);
        // The raw message (not replay-safe) must not validate.
        assertEq(account.isValidSignature(message, _factorSignature(message, P | S)), bytes4(0xffffffff));
    }

    function test_ERC1271_NoReplayAcrossAccountsSharingKeys() public {
        RutliAccount twin = factory.createAccount(_config(), bytes32(uint256(42))); // same keys, other address
        bytes32 message = keccak256("permit");
        bytes memory sig = _factorSignature(account.replaySafeHash(message), P | S);
        assertEq(account.isValidSignature(message, sig), IERC1271.isValidSignature.selector);
        assertEq(twin.isValidSignature(message, sig), bytes4(0xffffffff));
    }
}
