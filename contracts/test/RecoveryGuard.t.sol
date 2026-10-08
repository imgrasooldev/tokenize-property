// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Fixture} from "./helpers/Fixture.sol";
import {IIdentity} from "../script/VendorInterfaces.sol";
import {Governed} from "../src/common/Governed.sol";
import {RecoveryGuard} from "../src/guards/RecoveryGuard.sol";

contract RecoveryGuardTest is Fixture {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal aliceNewWallet = makeAddr("aliceNewWallet");
    bytes32 internal constant EVIDENCE = keccak256("court-order-LHC-2026-17.pdf");

    function setUp() public override {
        super.setUp();
        _onboard(alice);
        _onboard(bob);
        _mint(alice, 100);
    }

    function _proposeForced(uint256 amount) internal returns (uint256 id) {
        vm.prank(trusteeSafe);
        id = recovery.propose(RecoveryGuard.Kind.ForcedTransfer, alice, bob, address(0), amount, EVIDENCE);
    }

    function test_forcedTransfer_afterDelay() public {
        uint256 id = _proposeForced(40);
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(trusteeSafe);
        recovery.execute(id);
        assertEq(token.balanceOf(alice), 60);
        assertEq(token.balanceOf(bob), 40);
    }

    function test_I13_cannotExecuteBeforeDelay() public {
        uint256 id = _proposeForced(40);
        uint64 eta = recovery.getRequest(id).eta;
        vm.warp(eta - 1);
        vm.prank(trusteeSafe);
        vm.expectRevert(abi.encodeWithSelector(RecoveryGuard.TooEarly.selector, id, eta));
        recovery.execute(id);
    }

    function test_I13_executesOnlyOnce() public {
        uint256 id = _proposeForced(40);
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.startPrank(trusteeSafe);
        recovery.execute(id);
        vm.expectRevert(abi.encodeWithSelector(RecoveryGuard.NotPending.selector, id));
        recovery.execute(id);
        vm.stopPrank();
    }

    function test_I13_cancelledRequestNeverExecutes() public {
        uint256 id = _proposeForced(40);
        vm.prank(adminSafe);
        recovery.cancel(id);
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(trusteeSafe);
        vm.expectRevert(abi.encodeWithSelector(RecoveryGuard.NotPending.selector, id));
        recovery.execute(id);
        assertEq(token.balanceOf(alice), 100);
    }

    function test_onlyTrusteeProposesAndExecutes() public {
        address[3] memory callers = [adminSafe, opsSafe, alice];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, callers[i]));
            recovery.propose(RecoveryGuard.Kind.ForcedTransfer, alice, bob, address(0), 1, EVIDENCE);
        }
        uint256 id = _proposeForced(1);
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(adminSafe);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, adminSafe));
        recovery.execute(id);
    }

    function test_outsiderCannotCancel() public {
        uint256 id = _proposeForced(1);
        vm.prank(opsSafe);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, opsSafe));
        recovery.cancel(id);
    }

    function test_rejectsMalformedRequests() public {
        vm.startPrank(trusteeSafe);
        vm.expectRevert(RecoveryGuard.InvalidRequest.selector); // no evidence
        recovery.propose(RecoveryGuard.Kind.ForcedTransfer, alice, bob, address(0), 1, bytes32(0));
        vm.expectRevert(RecoveryGuard.InvalidRequest.selector); // same wallet
        recovery.propose(RecoveryGuard.Kind.ForcedTransfer, alice, alice, address(0), 1, EVIDENCE);
        vm.expectRevert(RecoveryGuard.InvalidRequest.selector); // zero amount
        recovery.propose(RecoveryGuard.Kind.ForcedTransfer, alice, bob, address(0), 0, EVIDENCE);
        vm.expectRevert(RecoveryGuard.InvalidRequest.selector); // recovery without ONCHAINID
        recovery.propose(RecoveryGuard.Kind.WalletRecovery, alice, aliceNewWallet, address(0), 0, EVIDENCE);
        vm.expectRevert(RecoveryGuard.InvalidRequest.selector); // recovery with amount
        recovery.propose(RecoveryGuard.Kind.WalletRecovery, alice, aliceNewWallet, identityOf[alice], 5, EVIDENCE);
        vm.stopPrank();
    }

    function test_walletRecovery_movesFullBalanceAndFreezeState() public {
        vm.prank(opsSafe);
        freezeGuard.freezePartial(alice, 30, bytes32("CASE-1"));

        // The investor (re-verified off-chain) authorises the new wallet on their ONCHAINID.
        vm.prank(alice);
        IIdentity(identityOf[alice]).addKey(keccak256(abi.encode(aliceNewWallet)), 1, 1);

        vm.prank(trusteeSafe);
        uint256 id =
            recovery.propose(RecoveryGuard.Kind.WalletRecovery, alice, aliceNewWallet, identityOf[alice], 0, EVIDENCE);
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(trusteeSafe);
        recovery.execute(id);

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(aliceNewWallet), 100);
        assertEq(token.getFrozenTokens(aliceNewWallet), 30, "frozen amount carried over");
        assertFalse(ir.contains(alice), "lost wallet removed from registry");
        assertTrue(ir.isVerified(aliceNewWallet));
    }

    function test_walletRecovery_failsIfNewWalletNotAuthorisedOnIdentity() public {
        vm.prank(trusteeSafe);
        uint256 id =
            recovery.propose(RecoveryGuard.Kind.WalletRecovery, alice, aliceNewWallet, identityOf[alice], 0, EVIDENCE);
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(trusteeSafe);
        vm.expectRevert("Recovery not possible");
        recovery.execute(id);
    }

    function test_worksWhileTokenPaused() public {
        uint256 id = _proposeForced(10);
        vm.prank(pauser);
        pauseGuard.pause("incident");
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(trusteeSafe);
        recovery.execute(id);
        assertEq(token.balanceOf(bob), 10);
    }

    function test_forcedTransferToUnverifiedWalletReverts() public {
        vm.prank(trusteeSafe);
        uint256 id =
            recovery.propose(RecoveryGuard.Kind.ForcedTransfer, alice, makeAddr("stranger"), address(0), 10, EVIDENCE);
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(trusteeSafe);
        vm.expectRevert("Transfer not possible");
        recovery.execute(id);
    }
}
