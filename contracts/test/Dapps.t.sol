// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RutliTestBase} from "./utils/RutliTestBase.sol";
import {RutliAccount} from "../src/RutliAccount.sol";
import {HelvetiaYieldVault} from "../src/demo/HelvetiaYieldVault.sol";
import {ScamAirdrop} from "../src/demo/ScamAirdrop.sol";

/// dApp interactions go through the coffre (two factors): a passkey alone can never approve or call a dApp.
contract DappsTest is RutliTestBase {
    HelvetiaYieldVault internal vault;
    ScamAirdrop internal scam;

    function setUp() public override {
        super.setUp();
        vault = new HelvetiaYieldVault(usdc);
        scam = new ScamAirdrop(usdc, mallory);
    }

    function _approveAndDeposit(uint256 amount) internal view returns (bytes memory) {
        RutliAccount.Call[] memory calls = new RutliAccount.Call[](2);
        calls[0] = RutliAccount.Call(address(usdc), 0, abi.encodeCall(usdc.approve, (address(vault), amount)));
        calls[1] = RutliAccount.Call(address(vault), 0, abi.encodeCall(vault.deposit, (amount, address(account))));
        return abi.encodeCall(RutliAccount.executeBatch, (calls));
    }

    function test_ApprovedDapp_DepositWithExactApproval() public {
        _runOk(_approveAndDeposit(1_000e6), P | S);
        assertEq(vault.maxWithdraw(address(account)), 1_000e6);
        assertEq(usdc.allowance(address(account), address(vault)), 0, "exact approval fully consumed");
    }

    function test_PasskeyAloneCannotTouchDapps() public {
        _expectRefused(_approveAndDeposit(1_000e6), P);
        bytes memory approveScam =
            _execute(address(usdc), 0, abi.encodeCall(usdc.approve, (address(scam), type(uint256).max)));
        _expectRefused(approveScam, P); // the classic drainer approval is impossible with a stolen phone
    }

    function test_Drainer_WhatSwissquoteRefusesToCoSign() public {
        // If the client insists and overrides with her own card (P+C), the chain lets her: it is her money.
        // This is exactly the batch the co-signer's simulation flags (unlimited approval + balance leaves).
        RutliAccount.Call[] memory calls = new RutliAccount.Call[](2);
        calls[0] = RutliAccount.Call(address(usdc), 0, abi.encodeCall(usdc.approve, (address(scam), type(uint256).max)));
        calls[1] = RutliAccount.Call(address(scam), 0, abi.encodeCall(scam.claimAirdrop, ()));
        uint256 before = usdc.balanceOf(address(account));
        _runOk(abi.encodeCall(RutliAccount.executeBatch, (calls)), P | C);
        assertEq(usdc.balanceOf(mallory), before, "everything drained");
    }

    function test_Describe_ReturnsTheWholeState() public {
        _runOk(abi.encodeCall(RutliAccount.freeze, ()), S);
        RutliAccount.AccountState memory st = account.describe();
        assertEq(st.passkeyX, passkeyX);
        assertEq(st.card, cardAddr);
        assertEq(st.cosigner, cosignerAddr);
        assertEq(st.guardian, guardianAddr);
        assertEq(st.recoveryDelay, RECOVERY_DELAY);
        assertEq(st.exitDelay, EXIT_DELAY);
        assertEq(st.frozenUntil, block.timestamp + FREEZE_DURATION);
        assertEq(st.minDelay, MIN_DELAY);
        assertEq(st.freezeDuration, FREEZE_DURATION);
        assertFalse(st.sovereign);
        assertEq(account.version(), "rutli-account-1.0.0");
        address[] memory tokens = account.allowanceTokens();
        assertEq(tokens[0], address(usdc));
        assertEq(tokens[1], address(0));
    }

    function test_SpendNativeToRejectingContract_Reverts() public {
        vm.deal(address(account), 1 ether);
        _expectExecutionRevert(
            _spend(address(0), address(usdc), 0.1 ether), // MockUSDC has no receive()
            P,
            abi.encodeWithSelector(RutliAccount.NativeTransferFailed.selector)
        );
    }
}
