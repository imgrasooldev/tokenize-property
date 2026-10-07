// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Fixture} from "./helpers/Fixture.sol";
import {Governed} from "../src/common/Governed.sol";
import {PauseGuard} from "../src/guards/PauseGuard.sol";
import {FreezeGuard} from "../src/guards/FreezeGuard.sol";

contract PauseGuardTest is Fixture {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        _onboard(alice);
        _onboard(bob);
        _mint(alice, 100);
    }

    function test_pauserOpsAndAdminCanPause() public {
        address[3] memory callers = [pauser, opsSafe, adminSafe];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            pauseGuard.pause("drill");
            assertTrue(token.paused());
            vm.prank(adminSafe);
            pauseGuard.unpause();
        }
    }

    function test_I10_pauserCannotUnpause() public {
        vm.startPrank(pauser);
        pauseGuard.pause("incident");
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, pauser));
        pauseGuard.unpause();
        vm.stopPrank();
        assertTrue(token.paused());
    }

    function test_I10_opsCannotUnpause() public {
        vm.prank(pauser);
        pauseGuard.pause("incident");
        vm.prank(opsSafe);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, opsSafe));
        pauseGuard.unpause();
    }

    function test_outsiderCannotPause() public {
        vm.prank(bob);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, bob));
        pauseGuard.pause("grief");
    }

    function test_I6_transfersBlockedWhilePaused() public {
        vm.prank(pauser);
        pauseGuard.pause("incident");
        vm.prank(alice);
        vm.expectRevert("Pausable: paused");
        token.transfer(bob, 1);
    }

    function test_transfersResumeAfterAdminUnpause() public {
        vm.prank(pauser);
        pauseGuard.pause("incident");
        vm.prank(adminSafe);
        pauseGuard.unpause();
        vm.prank(alice);
        token.transfer(bob, 1);
        assertEq(token.balanceOf(bob), 1);
    }

    function test_setPauser_onlyTimelock() public {
        vm.prank(adminSafe);
        vm.expectRevert();
        pauseGuard.setPauser(bob);

        address newPauser = makeAddr("newPauser");
        _timelockExec(address(pauseGuard), abi.encodeCall(PauseGuard.setPauser, (newPauser)));
        vm.prank(pauser);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, pauser));
        pauseGuard.pause("old key");
    }
}

contract FreezeGuardTest is Fixture {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    bytes32 internal constant CASE = bytes32("CASE-2026-001");

    function setUp() public override {
        super.setUp();
        _onboard(alice);
        _onboard(bob);
        _mint(alice, 100);
    }

    function test_I5_frozenAddressCannotSend() public {
        vm.prank(opsSafe);
        freezeGuard.freezeAddress(alice, CASE);
        assertTrue(token.isFrozen(alice));
        vm.prank(alice);
        vm.expectRevert("wallet is frozen");
        token.transfer(bob, 1);
    }

    function test_unfreezeRestoresTransfers() public {
        vm.startPrank(opsSafe);
        freezeGuard.freezeAddress(alice, CASE);
        freezeGuard.unfreezeAddress(alice, CASE);
        vm.stopPrank();
        vm.prank(alice);
        token.transfer(bob, 1);
    }

    function test_I5_partialFreezeLocksOnlyThatAmount() public {
        vm.prank(opsSafe);
        freezeGuard.freezePartial(alice, 70, CASE);
        assertEq(token.getFrozenTokens(alice), 70);

        vm.startPrank(alice);
        vm.expectRevert("Insufficient Balance");
        token.transfer(bob, 31);
        token.transfer(bob, 30);
        vm.stopPrank();

        vm.prank(opsSafe);
        freezeGuard.unfreezePartial(alice, 70, CASE);
        vm.prank(alice);
        token.transfer(bob, 70);
    }

    function test_requiresCaseId() public {
        vm.prank(opsSafe);
        vm.expectRevert(FreezeGuard.MissingCaseId.selector);
        freezeGuard.freezeAddress(alice, bytes32(0));
    }

    function test_onlyOpsSafe() public {
        address[3] memory callers = [pauser, adminSafe, alice];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, callers[i]));
            freezeGuard.freezeAddress(bob, CASE);
        }
    }
}
