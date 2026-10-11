// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RutliTestBase} from "./utils/RutliTestBase.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {RutliAccount} from "../src/RutliAccount.sol";

/**
 * Stateful fuzzing of the custody claim.
 *
 * The adversary holds BOTH institutional keys (Swissquote's co-signer and the guardian: the
 * "Swissquote + partner collude" grey zone of the challenge) and plays random sequences of everything
 * those keys can sign, interleaved with time passing. The client does only one thing: when her app
 * shows a pending recovery she did not ask for, she cancels it with Face ID.
 *
 * Invariants: the client's funds never move, and her keys are never replaced.
 */
contract InstitutionsAdversaryInvariantTest is StdInvariant, RutliTestBase {
    uint256 internal initialBalance;
    uint256 public refusedAttempts;
    uint256 public recoveriesCancelledByClient;

    function setUp() public override {
        super.setUp();
        initialBalance = usdc.balanceOf(address(account));

        bytes4[] memory selectors = new bytes4[](7);
        selectors[0] = this.adversaryStartsRecovery.selector;
        selectors[1] = this.adversaryTriesToMoveFunds.selector;
        selectors[2] = this.adversaryTriesToSpend.selector;
        selectors[3] = this.adversaryTriesToReplaceKeys.selector;
        selectors[4] = this.adversaryTriesToBlockClientExit.selector;
        selectors[5] = this.adversaryFreezes.selector;
        selectors[6] = this.timePasses.selector;
        targetSelector(FuzzSelector({addr: address(this), selectors: selectors}));
        targetContract(address(this));
    }

    // ── adversary actions (S+G keys) ─────────────────────────────────────────

    function _submit(bytes memory callData, uint8 factors) internal returns (bool accepted) {
        PackedUserOperation memory op = _op(callData, factors);
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        try entryPoint.handleOps(ops, bundler) {
            accepted = true;
        } catch {
            refusedAttempts++;
        }
    }

    function adversaryStartsRecovery(uint256 seed) external {
        (bytes32 nx, bytes32 ny) = _p256Public(bound(seed, 1, 1e30));
        address newCard = vm.addr(bound(seed, 1, 1e30) + 7);
        _submit(abi.encodeCall(RutliAccount.initiateRecovery, (nx, ny, newCard, bytes32(seed))), S | G);
    }

    function adversaryTriesToMoveFunds(uint256 amount) external {
        amount = bound(amount, 1, initialBalance);
        _submit(_usdcTransfer(mallory, amount), S | G);
        _submit(_usdcTransfer(mallory, amount), S);
        _submit(_usdcTransfer(mallory, amount), G);
    }

    function adversaryTriesToSpend(uint256 amount) external {
        amount = bound(amount, 1, DAILY_USDC);
        _submit(_spend(address(usdc), mallory, amount), S | G);
    }

    function adversaryTriesToReplaceKeys(uint256 seed) external {
        (bytes32 nx, bytes32 ny) = _p256Public(bound(seed, 1, 1e30));
        _submit(abi.encodeCall(RutliAccount.rotatePasskey, (nx, ny)), S | G);
        _submit(abi.encodeCall(RutliAccount.rotateCard, (mallory)), S | G);
        _submit(abi.encodeCall(RutliAccount.setGuardian, (mallory)), S | G);
        _submit(abi.encodeCall(RutliAccount.setAllowance, (address(usdc), type(uint128).max)), S | G);
    }

    function adversaryTriesToBlockClientExit() external {
        _submit(abi.encodeCall(RutliAccount.cancelExit, ()), S | G);
        _submit(abi.encodeCall(RutliAccount.cancelRecovery, ()), S | G);
    }

    function adversaryFreezes() external {
        _submit(abi.encodeCall(RutliAccount.freeze, ()), S);
    }

    /// @dev Time passes, but never a full recovery delay without the client looking at her phone.
    function timePasses(uint256 seconds_) external {
        _clientReviewsPendingRequests();
        vm.warp(block.timestamp + bound(seconds_, 1, RECOVERY_DELAY - 1));
        _clientReviewsPendingRequests();
        // Anyone may try to finalize: it must fail while nothing legitimate is pending.
        try account.finalizeRecovery() {} catch {}
    }

    /// @dev The client's only reaction: "I did not ask for this recovery" → cancel with Face ID.
    function _clientReviewsPendingRequests() internal {
        if (account.pendingRecovery().executeAfter != 0) {
            PackedUserOperation memory op = _op(abi.encodeCall(RutliAccount.cancelRecovery, ()), P);
            (bool ok,) = _handle(op);
            require(ok, "client could not cancel");
            recoveriesCancelledByClient++;
        }
    }

    // ── invariants ───────────────────────────────────────────────────────────

    function invariant_FundsNeverMove() public view {
        assertEq(usdc.balanceOf(address(account)), initialBalance);
        assertEq(usdc.balanceOf(mallory), 0);
    }

    function invariant_ClientKeysNeverReplaced() public view {
        (bytes32 x, bytes32 y) = account.passkey();
        assertEq(x, passkeyX);
        assertEq(y, passkeyY);
        assertEq(account.card(), cardAddr);
        assertEq(account.guardian(), guardianAddr);
        assertFalse(account.sovereign());
    }

    function invariant_AllowanceUntouched() public view {
        (uint256 limit,,,) = account.allowance(address(usdc));
        assertEq(limit, DAILY_USDC);
    }
}
