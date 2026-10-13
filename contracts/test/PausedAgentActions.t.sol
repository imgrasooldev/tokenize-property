// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Fixture} from "./helpers/Fixture.sol";
import {IssuanceGuard} from "../src/guards/IssuanceGuard.sol";
import {RecoveryGuard} from "../src/guards/RecoveryGuard.sol";

/// What agent actions do while the token is paused or balances are frozen. The exit and recovery
/// specs (docs/specs/S-04, S-05, S-06) rely on this: the token stays paused until secondary trading
/// is approved, yet redemption burns and trustee forced transfers must still work.
contract PausedAgentActionsTest is Fixture {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    bytes32 internal constant EVIDENCE = keccak256("succession-certificate-2026-03.pdf");

    function setUp() public override {
        super.setUp();
        _onboard(alice);
        _onboard(bob);
        _mint(alice, 100);
        vm.prank(pauser);
        pauseGuard.pause("transfer-closed");
    }

    function test_mintRefusedWhilePaused() public {
        vm.prank(issuanceSafe);
        vm.expectRevert(IssuanceGuard.TokenPaused.selector);
        issuance.mint(alice, 1, bytes32("sub-while-paused"));
    }

    function test_burnWorksWhilePaused() public {
        vm.prank(issuanceSafe);
        issuance.burn(alice, 40, bytes32("redeem-paused"));
        assertTrue(token.paused());
        assertEq(token.balanceOf(alice), 60);
        assertEq(token.totalSupply(), 60);
    }

    function test_burnWorksOnFrozenTokens() public {
        vm.startPrank(opsSafe);
        freezeGuard.freezePartial(alice, 70, bytes32("case-1"));
        freezeGuard.freezeAddress(alice, bytes32("case-1"));
        vm.stopPrank();
        vm.prank(issuanceSafe);
        issuance.burn(alice, 100, bytes32("redeem-frozen"));
        assertEq(token.balanceOf(alice), 0);
        assertEq(token.getFrozenTokens(alice), 0);
    }

    function test_forcedTransferWorksWhilePaused() public {
        vm.prank(trusteeSafe);
        uint256 id = recovery.propose(RecoveryGuard.Kind.ForcedTransfer, alice, bob, address(0), 30, EVIDENCE);
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(trusteeSafe);
        recovery.execute(id);
        assertTrue(token.paused());
        assertEq(token.balanceOf(alice), 70);
        assertEq(token.balanceOf(bob), 30);
    }

    function test_investorTransferStillBlockedWhilePaused() public {
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        token.transfer(bob, 1);
    }
}
