// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {RutliTestBase} from "./utils/RutliTestBase.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {RutliAccount} from "../src/RutliAccount.sol";
import {RutliFactory} from "../src/RutliFactory.sol";

contract RutliFactoryTest is RutliTestBase {
    function test_AddressIsDeterministicAndCreationIdempotent() public {
        RutliAccount.InitConfig memory cfg = _config();
        address predicted = factory.getAddress(cfg, bytes32(uint256(7)));
        assertEq(predicted.code.length, 0);
        RutliAccount a = factory.createAccount(cfg, bytes32(uint256(7)));
        assertEq(address(a), predicted);
        RutliAccount again = factory.createAccount(cfg, bytes32(uint256(7)));
        assertEq(address(again), predicted, "second call returns the same account");
    }

    function test_DifferentKeysGiveADifferentAddress_NoFrontRunning() public view {
        RutliAccount.InitConfig memory cfg = _config();
        RutliAccount.InitConfig memory attackerCfg = _config();
        attackerCfg.card = mallory; // an attacker cannot squat the client's address with his own card
        assertTrue(factory.getAddress(cfg, bytes32(0)) != factory.getAddress(attackerCfg, bytes32(0)));
    }

    function test_CounterfactualDeploymentThroughInitCode() public {
        // A brand-new client: the address is known before deployment and can already receive USDC.
        RutliAccount.InitConfig memory cfg = _config();
        bytes32 salt = keccak256("claire-wallet");
        address predicted = factory.getAddress(cfg, salt);
        vm.prank(treasury);
        usdc.mint(predicted, 500e6); // bank transfer to the not-yet-deployed wallet

        PackedUserOperation memory op = _baseOp(predicted, _spend(address(usdc), bob, 50e6));
        op.initCode = abi.encodePacked(address(factory), abi.encodeCall(RutliFactory.createAccount, (cfg, salt)));
        _sponsor(op);
        op.signature = _factorSignature(_opHash(op), P);
        (bool ok,) = _handle(op);

        assertTrue(ok);
        assertGt(predicted.code.length, 0, "deployed by the first operation");
        assertEq(usdc.balanceOf(bob), 50e6);
        assertEq(RutliAccount(payable(predicted)).card(), cardAddr);
    }
}
