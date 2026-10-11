// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RutliTestBase} from "./utils/RutliTestBase.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {IEntryPoint as AAEntryPoint} from "@account-abstraction/contracts/interfaces/IEntryPoint.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {RutliPaymaster} from "../src/RutliPaymaster.sol";

contract RutliPaymasterTest is RutliTestBase {
    function _submitExpecting(PackedUserOperation memory op, string memory reason) internal {
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert(abi.encodeWithSelector(AAEntryPoint.FailedOp.selector, 0, reason));
        entryPoint.handleOps(ops, bundler);
    }

    function test_SponsoredOperation_PaidFromSwissquoteDeposit() public {
        uint256 before = paymaster.getDeposit();
        _runOk(_spend(address(usdc), bob, 1e6), P);
        uint256 cost = before - paymaster.getDeposit();
        assertGt(cost, 0);
        assertEq(address(account).balance, 0);
        emit log_named_uint("gas paid by Swissquote (wei)", cost);
    }

    function test_RejectsSponsorshipFromWrongSigner() public {
        PackedUserOperation memory op = _baseOp(address(account), _spend(address(usdc), bob, 1e6));
        _sponsorWith(op, 0xBAD, uint48(block.timestamp + 10 minutes), 0);
        op.signature = _factorSignature(_opHash(op), P);
        _submitExpecting(op, "AA34 signature error");
    }

    function test_RejectsExpiredSponsorship() public {
        PackedUserOperation memory op = _baseOp(address(account), _spend(address(usdc), bob, 1e6));
        _sponsorWith(op, sponsorPk, uint48(block.timestamp - 1), 0);
        op.signature = _factorSignature(_opHash(op), P);
        _submitExpecting(op, "AA32 paymaster expired or not due");
    }

    function test_RejectsOpenEndedSponsorship() public {
        PackedUserOperation memory op = _baseOp(address(account), _spend(address(usdc), bob, 1e6));
        _sponsorWith(op, sponsorPk, 0, 0); // validUntil = 0 means "forever" to the EntryPoint
        op.signature = _factorSignature(_opHash(op), P);
        _submitExpecting(op, "AA34 signature error");
    }

    function test_SponsorshipIsBoundToTheExactOperation() public {
        // Swissquote sponsored a 1 USDC payment; the client (or an attacker) swaps the calldata.
        PackedUserOperation memory op = _baseOp(address(account), _spend(address(usdc), bob, 1e6));
        _sponsor(op);
        op.callData = _spend(address(usdc), bob, 999e6);
        op.signature = _factorSignature(_opHash(op), P);
        _submitExpecting(op, "AA34 signature error");
    }

    function test_RejectsMalformedPaymasterData() public {
        PackedUserOperation memory op = _baseOp(address(account), _spend(address(usdc), bob, 1e6));
        op.paymasterAndData = abi.encodePacked(address(paymaster), uint128(300_000), uint128(0), uint48(0));
        op.signature = _factorSignature(_opHash(op), P);
        _submitExpecting(op, "AA34 signature error");
    }

    function test_UnsponsoredOperation_AccountPaysItsOwnGas() public {
        vm.deal(address(account), 1 ether);
        PackedUserOperation memory op = _baseOp(address(account), _spend(address(usdc), bob, 1e6));
        op.signature = _factorSignature(_opHash(op), P);
        (bool ok,) = _handle(op);
        assertTrue(ok);
        assertLt(address(account).balance, 1 ether);
    }

    function test_OnlyOwnerManagesSignerAndDeposit() public {
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, mallory));
        paymaster.setSigner(mallory);

        vm.prank(treasury);
        vm.expectRevert(RutliPaymaster.InvalidSigner.selector);
        paymaster.setSigner(address(0));

        vm.prank(treasury);
        paymaster.setSigner(address(0x1234));
        assertEq(paymaster.signer(), address(0x1234));

        uint256 before = treasury.balance;
        vm.prank(treasury);
        paymaster.withdrawTo(payable(treasury), 1 ether);
        assertEq(treasury.balance, before + 1 ether);
    }
}
