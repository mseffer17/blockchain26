// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RutliTestBase} from "./utils/RutliTestBase.sol";
import {RutliAccount} from "../src/RutliAccount.sol";

/**
 * The pact as an exhaustive truth table: every protected function × every one of the 16 factor
 * combinations. The expected table below is written independently of the contract, from the rules
 * stated in the README, so any drift between documentation and code fails the build.
 *
 * It also proves the property the regulator cares about:
 *   Swissquote alone, the guardian alone, or both together can NEVER move funds.
 */
contract AuthorizationMatrixTest is RutliTestBase {
    bytes4[] internal selectors;

    function setUp() public override {
        super.setUp();
        selectors.push(RutliAccount.spend.selector);
        selectors.push(RutliAccount.execute.selector);
        selectors.push(RutliAccount.executeBatch.selector);
        selectors.push(RutliAccount.rotatePasskey.selector);
        selectors.push(RutliAccount.rotateCard.selector);
        selectors.push(RutliAccount.setCosigner.selector);
        selectors.push(RutliAccount.setGuardian.selector);
        selectors.push(RutliAccount.setAllowance.selector);
        selectors.push(RutliAccount.setDelays.selector);
        selectors.push(RutliAccount.freeze.selector);
        selectors.push(RutliAccount.unfreeze.selector);
        selectors.push(RutliAccount.initiateRecovery.selector);
        selectors.push(RutliAccount.cancelRecovery.selector);
        selectors.push(RutliAccount.initiateExit.selector);
        selectors.push(RutliAccount.cancelExit.selector);
        // Never callable through a user operation:
        selectors.push(RutliAccount.finalizeRecovery.selector);
        selectors.push(RutliAccount.finalizeExit.selector);
        selectors.push(RutliAccount.initialize.selector);
        selectors.push(bytes4(0xdeadbeef));
    }

    /// @dev The rules, restated as plain boolean logic (normal mode).
    function _expected(bytes4 sel, uint8 m) internal pure returns (bool) {
        bool p = m & P != 0;
        bool c = m & C != 0;
        bool s = m & S != 0;
        bool g = m & G != 0;
        if (sel == RutliAccount.spend.selector) return p;
        if (sel == RutliAccount.execute.selector || sel == RutliAccount.executeBatch.selector) return p && (s || c);
        if (sel == RutliAccount.rotatePasskey.selector) return (p && (s || c)) || (s && c);
        if (sel == RutliAccount.rotateCard.selector || sel == RutliAccount.setCosigner.selector) return p && (s || c);
        if (
            sel == RutliAccount.setGuardian.selector || sel == RutliAccount.setAllowance.selector
                || sel == RutliAccount.setDelays.selector || sel == RutliAccount.unfreeze.selector
        ) return p && c;
        if (sel == RutliAccount.freeze.selector) return s || g || c;
        if (sel == RutliAccount.initiateRecovery.selector) return s && g;
        if (sel == RutliAccount.cancelRecovery.selector || sel == RutliAccount.cancelExit.selector) return p || c;
        if (sel == RutliAccount.initiateExit.selector) return c;
        return false;
    }

    /// @dev Sovereign mode (after an exit): the card is full authority, S and G no longer exist.
    function _expectedSovereign(bytes4 sel, uint8 m) internal pure returns (bool) {
        bool p = m & P != 0;
        bool c = m & C != 0;
        bool s = m & S != 0;
        bool g = m & G != 0;
        bool full = (p && (s || c)) || c;
        if (sel == RutliAccount.spend.selector) return p || full;
        if (sel == RutliAccount.execute.selector || sel == RutliAccount.executeBatch.selector) return full;
        if (sel == RutliAccount.rotatePasskey.selector) return full || (s && c);
        if (sel == RutliAccount.rotateCard.selector || sel == RutliAccount.setCosigner.selector) return full;
        if (
            sel == RutliAccount.setGuardian.selector || sel == RutliAccount.setAllowance.selector
                || sel == RutliAccount.setDelays.selector || sel == RutliAccount.unfreeze.selector
        ) return c;
        if (sel == RutliAccount.freeze.selector) return s || g || c;
        if (sel == RutliAccount.initiateRecovery.selector || sel == RutliAccount.initiateExit.selector) return false;
        if (sel == RutliAccount.cancelRecovery.selector || sel == RutliAccount.cancelExit.selector) return p || c;
        return false;
    }

    function test_Matrix_MatchesThePact() public view {
        for (uint256 i = 0; i < selectors.length; ++i) {
            for (uint8 m = 0; m < 16; ++m) {
                assertEq(
                    account.canAuthorize(selectors[i], m),
                    _expected(selectors[i], m),
                    string.concat("selector #", vm.toString(i), " mask ", vm.toString(m))
                );
            }
        }
    }

    function test_Matrix_SovereignMode() public {
        vm.prank(cardAddr);
        account.initiateExit();
        vm.warp(block.timestamp + EXIT_DELAY);
        account.finalizeExit();
        for (uint256 i = 0; i < selectors.length; ++i) {
            for (uint8 m = 0; m < 16; ++m) {
                assertEq(
                    account.canAuthorize(selectors[i], m),
                    _expectedSovereign(selectors[i], m),
                    string.concat("sovereign selector #", vm.toString(i), " mask ", vm.toString(m))
                );
            }
        }
    }

    /// @notice The custody property, checked for every subset of {Swissquote, guardian}.
    function test_Institutions_CanNeverMoveFunds() public view {
        uint8[3] memory institutionalMasks = [S, G, S | G];
        bytes4[3] memory fundMoving =
            [RutliAccount.spend.selector, RutliAccount.execute.selector, RutliAccount.executeBatch.selector];
        for (uint256 i = 0; i < institutionalMasks.length; ++i) {
            for (uint256 j = 0; j < fundMoving.length; ++j) {
                assertFalse(account.canAuthorize(fundMoving[j], institutionalMasks[i]));
            }
            // ...nor replace the client's keys immediately, nor block the client's exit.
            assertFalse(account.canAuthorize(RutliAccount.rotatePasskey.selector, institutionalMasks[i]));
            assertFalse(account.canAuthorize(RutliAccount.rotateCard.selector, institutionalMasks[i]));
            assertFalse(account.canAuthorize(RutliAccount.cancelExit.selector, institutionalMasks[i]));
            assertFalse(account.canAuthorize(RutliAccount.cancelRecovery.selector, institutionalMasks[i]));
        }
    }

    /// @notice Same property, end to end through the EntryPoint with real signatures for all 16 masks.
    function test_Matrix_EndToEnd_Execute() public {
        bytes memory callData = _usdcTransfer(bob, 1e6);
        uint256 expectedBalance;
        for (uint8 m = 1; m < 16; ++m) {
            if (_expected(RutliAccount.execute.selector, m)) {
                _runOk(callData, m);
                expectedBalance += 1e6;
            } else {
                _expectRefused(callData, m);
            }
            assertEq(usdc.balanceOf(bob), expectedBalance);
        }
    }

    function test_Matrix_EndToEnd_Spend() public {
        bytes memory callData = _spend(address(usdc), bob, 1e6);
        for (uint8 m = 1; m < 16; ++m) {
            if (_expected(RutliAccount.spend.selector, m)) _runOk(callData, m);
            else _expectRefused(callData, m);
        }
    }
}
