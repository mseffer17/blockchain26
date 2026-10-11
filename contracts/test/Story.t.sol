// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {console2} from "forge-std/console2.sol";
import {RutliTestBase} from "./utils/RutliTestBase.sol";
import {PackedUserOperation} from "@account-abstraction/contracts/interfaces/PackedUserOperation.sol";
import {RutliAccount} from "../src/RutliAccount.sol";
import {RutliFactory} from "../src/RutliFactory.sol";

/**
 * The demo story, on-chain, in one test. Run it with:
 *
 *   forge test --match-test test_TheWholeStory -vv
 *
 * create → sign (gasless) → phone stolen → thief limited and refused → recovery → Swissquote disappears → exit.
 */
contract StoryTest is RutliTestBase {
    function test_TheWholeStory() public {
        console2.log("1. Claire creates her wallet (passkey + recovery card), Swissquote sponsors the deployment");
        RutliAccount.InitConfig memory cfg = _config();
        bytes32 salt = keccak256("claire");
        address wallet = factory.getAddress(cfg, salt);
        vm.prank(treasury);
        usdc.mint(wallet, 5_000e6);
        console2.log("   wallet:", wallet);
        console2.log("   USDC received from her Swissquote account:", usdc.balanceOf(wallet) / 1e6);

        PackedUserOperation memory op = _baseOp(wallet, _spend(address(usdc), bob, 20e6));
        op.initCode = abi.encodePacked(address(factory), abi.encodeCall(RutliFactory.createAccount, (cfg, salt)));
        _sponsor(op);
        op.signature = _factorSignature(_opHash(op), P);
        (bool ok,) = _handle(op);
        assertTrue(ok);
        account = RutliAccount(payable(wallet));
        console2.log("2. First payment, Face ID only, no ETH needed: 20 USDC to Bob. ETH balance:", wallet.balance);

        _runOk(_usdcTransfer(bob, 2_000e6), P | S);
        console2.log("3. 2'000 USDC from the coffre: Face ID + Swissquote co-signature");

        console2.log("4. Mallory steals the phone (and knows the passcode and the email password)");
        _runOk(_spend(address(usdc), mallory, 900e6), P);
        console2.log("   - she empties the porte-monnaie: 900 USDC, the daily maximum");
        (bool drained,) = _run(_spend(address(usdc), mallory, 500e6), P);
        assertFalse(drained);
        console2.log("   - one more passkey-only payment: refused by the daily allowance");
        _expectRefused(_usdcTransfer(mallory, 2_000e6), P);
        console2.log("   - the coffre without a second factor: refused by the EntryPoint");

        _runOk(abi.encodeCall(RutliAccount.freeze, ()), S);
        console2.log("5. Claire calls the hotline: Swissquote freezes passkey spending (it cannot move funds)");
        (bool afterFreeze,) = _run(_spend(address(usdc), mallory, 1e6), P);
        assertFalse(afterFreeze);

        uint256 newPasskeyPk = 0xC1A12E;
        (bytes32 nx, bytes32 ny) = _p256Public(newPasskeyPk);
        _runOk(abi.encodeCall(RutliAccount.rotatePasskey, (nx, ny)), C | S);
        console2.log("6. New phone + recovery card + video identification: the passkey is replaced");
        _expectRefusedWithOldPasskey();
        console2.log("   Mallory's phone is now worthless");

        console2.log("7. Swissquote disappears. Claire only has her paper card and a public RPC.");
        vm.prank(cardAddr);
        account.initiateExit();
        vm.warp(block.timestamp + EXIT_DELAY);
        account.finalizeExit();
        address newWallet = makeAddr("claire-anywhere");
        uint256 balance = usdc.balanceOf(wallet);
        vm.prank(cardAddr);
        account.execute(address(usdc), 0, abi.encodeCall(usdc.transfer, (newWallet, balance)));
        console2.log(
            "   after 30 days, sovereign mode; she sweeps USDC to any wallet:", usdc.balanceOf(newWallet) / 1e6
        );

        assertEq(usdc.balanceOf(mallory), 900e6, "the thief got the porte-monnaie, nothing more");
        assertEq(usdc.balanceOf(newWallet), 5_000e6 - 20e6 - 2_000e6 - 900e6);
    }

    function _expectRefusedWithOldPasskey() internal {
        PackedUserOperation memory op = _baseOp(address(account), _spend(address(usdc), mallory, 1e6));
        _sponsor(op);
        op.signature = _factorSignature(_opHash(op), P); // old passkey
        PackedUserOperation[] memory ops = new PackedUserOperation[](1);
        ops[0] = op;
        vm.expectRevert();
        entryPoint.handleOps(ops, bundler);
    }
}
