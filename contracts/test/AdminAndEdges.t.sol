// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Fixture} from "./helpers/Fixture.sol";
import {Governed} from "../src/common/Governed.sol";
import {IERC3643Token, IERC3643IdentityRegistry} from "../src/interfaces/IERC3643.sol";
import {PauseGuard} from "../src/guards/PauseGuard.sol";
import {FreezeGuard} from "../src/guards/FreezeGuard.sol";
import {RecoveryGuard} from "../src/guards/RecoveryGuard.sol";
import {RegistrarGuard} from "../src/guards/RegistrarGuard.sol";
import {IssuanceGuard} from "../src/guards/IssuanceGuard.sol";
import {DistributionRegistry} from "../src/registries/DistributionRegistry.sol";
import {DocumentRegistry} from "../src/registries/DocumentRegistry.sol";
import {StateAnchor} from "../src/anchor/StateAnchor.sol";

/// @notice Every owner-only setter: only the timelock may call it, zero addresses are refused, and the
///         change takes effect. Every constructor refuses zero addresses.
contract GuardAdminTest is Fixture {
    address internal next = makeAddr("next");
    address internal stranger = makeAddr("stranger");

    function _assertOwnerOnly(address target, bytes memory call) internal {
        vm.prank(stranger);
        (bool ok, bytes memory ret) = target.call(call);
        assertFalse(ok, "non-owner call must fail");
        assertEq(bytes4(ret), Ownable.OwnableUnauthorizedAccount.selector);
    }

    function _assertRejectsZero(address target, bytes memory call) internal {
        vm.prank(address(timelock));
        (bool ok, bytes memory ret) = target.call(call);
        assertFalse(ok, "zero address must fail");
        assertEq(bytes4(ret), Governed.ZeroAddress.selector);
    }

    function _setAndCheck(address target, bytes memory setCall, bytes memory getCall) internal {
        vm.prank(address(timelock));
        (bool ok,) = target.call(setCall);
        assertTrue(ok, "owner call must succeed");
        (, bytes memory ret) = target.staticcall(getCall);
        assertEq(abi.decode(ret, (address)), next);
    }

    function _checkSetter(address target, bytes4 setter, bytes4 getter) internal {
        _assertOwnerOnly(target, abi.encodeWithSelector(setter, next));
        _assertRejectsZero(target, abi.encodeWithSelector(setter, address(0)));
        _setAndCheck(target, abi.encodeWithSelector(setter, next), abi.encodeWithSelector(getter));
    }

    function test_allSetters() public {
        _checkSetter(address(issuance), IssuanceGuard.setIssuer.selector, bytes4(keccak256("issuer()")));
        _checkSetter(address(pauseGuard), PauseGuard.setPauser.selector, bytes4(keccak256("pauser()")));
        _checkSetter(address(pauseGuard), PauseGuard.setOpsSafe.selector, bytes4(keccak256("opsSafe()")));
        _checkSetter(address(pauseGuard), PauseGuard.setAdminSafe.selector, bytes4(keccak256("adminSafe()")));
        _checkSetter(address(freezeGuard), FreezeGuard.setOpsSafe.selector, bytes4(keccak256("opsSafe()")));
        _checkSetter(address(recovery), RecoveryGuard.setTrusteeSafe.selector, bytes4(keccak256("trusteeSafe()")));
        _checkSetter(address(recovery), RecoveryGuard.setAdminSafe.selector, bytes4(keccak256("adminSafe()")));
        _checkSetter(address(registrarGuard), RegistrarGuard.setRegistrar.selector, bytes4(keccak256("registrar()")));
        _checkSetter(address(distributions), DistributionRegistry.setOpsSafe.selector, bytes4(keccak256("opsSafe()")));
        _checkSetter(
            address(distributions), DistributionRegistry.setTrusteeSafe.selector, bytes4(keccak256("trusteeSafe()"))
        );
        _checkSetter(address(documents), DocumentRegistry.setOpsSafe.selector, bytes4(keccak256("opsSafe()")));
    }

    // One test per constructor: Foundry coverage misattributes several reverting `new` calls in one test.

    function test_ctor_issuance() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new IssuanceGuard(address(timelock), IERC3643Token(address(0)), issuanceSafe);
    }

    function test_ctor_pause_token() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new PauseGuard(address(timelock), IERC3643Token(address(0)), pauser, opsSafe, adminSafe);
    }

    function test_ctor_pause_pauser() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new PauseGuard(address(timelock), IERC3643Token(address(token)), address(0), opsSafe, adminSafe);
    }

    function test_ctor_pause_ops() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new PauseGuard(address(timelock), IERC3643Token(address(token)), pauser, address(0), adminSafe);
    }

    function test_ctor_pause_admin() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new PauseGuard(address(timelock), IERC3643Token(address(token)), pauser, opsSafe, address(0));
    }

    function test_ctor_freeze_token() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new FreezeGuard(address(timelock), IERC3643Token(address(0)), opsSafe);
    }

    function test_ctor_freeze_ops() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new FreezeGuard(address(timelock), IERC3643Token(address(token)), address(0));
    }

    function test_ctor_recovery_token() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new RecoveryGuard(address(timelock), IERC3643Token(address(0)), trusteeSafe, adminSafe);
    }

    function test_ctor_recovery_trustee() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new RecoveryGuard(address(timelock), IERC3643Token(address(token)), address(0), adminSafe);
    }

    function test_ctor_recovery_admin() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new RecoveryGuard(address(timelock), IERC3643Token(address(token)), trusteeSafe, address(0));
    }

    function test_ctor_registrar_registry() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new RegistrarGuard(address(timelock), IERC3643IdentityRegistry(address(0)), registrar, 10);
    }

    function test_ctor_registrar_key() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new RegistrarGuard(address(timelock), IERC3643IdentityRegistry(address(ir)), address(0), 10);
    }

    function test_ctor_distribution_ops() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new DistributionRegistry(address(timelock), address(0), trusteeSafe);
    }

    function test_ctor_distribution_trustee() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new DistributionRegistry(address(timelock), opsSafe, address(0));
    }

    function test_ctor_document_ops() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new DocumentRegistry(address(timelock), address(0));
    }

    function test_ctor_anchor_key() public {
        vm.expectRevert(Governed.ZeroAddress.selector);
        new StateAnchor(address(timelock), address(0));
    }

    function test_ctor_zeroOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableInvalidOwner.selector, address(0)));
        new DocumentRegistry(address(0), opsSafe);
    }

    function test_registrar_rejectsZeroAccountOrIdentity() public {
        vm.startPrank(registrar);
        vm.expectRevert(Governed.ZeroAddress.selector);
        registrarGuard.register(address(0), makeAddr("id"), PAKISTAN);
        vm.expectRevert(Governed.ZeroAddress.selector);
        registrarGuard.register(makeAddr("w"), address(0), PAKISTAN);
        vm.stopPrank();
    }

    function test_recovery_rejectsZeroWallets() public {
        vm.startPrank(trusteeSafe);
        vm.expectRevert(RecoveryGuard.InvalidRequest.selector);
        recovery.propose(RecoveryGuard.Kind.ForcedTransfer, address(0), next, address(0), 1, bytes32("e"));
        vm.expectRevert(RecoveryGuard.InvalidRequest.selector);
        recovery.propose(RecoveryGuard.Kind.ForcedTransfer, next, address(0), address(0), 1, bytes32("e"));
        vm.expectRevert(RecoveryGuard.InvalidRequest.selector);
        recovery.propose(RecoveryGuard.Kind.ForcedTransfer, stranger, next, makeAddr("oid"), 1, bytes32("e"));
        vm.stopPrank();
    }

    function test_recovery_trusteeCanCancelAndUnknownIdIsNotPending() public {
        vm.startPrank(trusteeSafe);
        uint256 id = recovery.propose(RecoveryGuard.Kind.ForcedTransfer, stranger, next, address(0), 1, bytes32("e"));
        recovery.cancel(id);
        assertEq(uint8(recovery.getRequest(id).status), uint8(RecoveryGuard.Status.Cancelled));
        vm.expectRevert(abi.encodeWithSelector(RecoveryGuard.NotPending.selector, 999));
        recovery.cancel(999);
        vm.stopPrank();
    }

    function test_freeze_allActionsNeedOpsAndCase() public {
        bytes32 c = bytes32("CASE");
        vm.startPrank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, stranger));
        freezeGuard.unfreezeAddress(next, c);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, stranger));
        freezeGuard.freezePartial(next, 1, c);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, stranger));
        freezeGuard.unfreezePartial(next, 1, c);
        vm.stopPrank();
    }

    function test_issuance_burnOnlyIssuer() public {
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, stranger));
        issuance.burn(next, 1, bytes32("r"));
    }
}

contract RegistryEdgesTest is Test {
    address internal timelock = makeAddr("timelock");
    address internal opsSafe = makeAddr("opsSafe");
    address internal trusteeSafe = makeAddr("trusteeSafe");

    function test_distribution_unknownIdAndZeroPayoutHash() public {
        DistributionRegistry reg = new DistributionRegistry(timelock, opsSafe, trusteeSafe);
        vm.prank(trusteeSafe);
        vm.expectRevert(
            abi.encodeWithSelector(DistributionRegistry.WrongStatus.selector, 7, DistributionRegistry.Status.None)
        );
        reg.reject(7, "unknown");

        vm.expectRevert(
            abi.encodeWithSelector(DistributionRegistry.WrongStatus.selector, 7, DistributionRegistry.Status.None)
        );
        reg.finalize(7);

        vm.startPrank(opsSafe);
        vm.expectRevert(DistributionRegistry.InvalidDistribution.selector);
        reg.recordPayout(7, bytes32(0));
        vm.stopPrank();

        vm.prank(trusteeSafe);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, trusteeSafe));
        reg.recordPayout(7, bytes32("x"));
    }

    function test_document_newDocAlreadySuperseded() public {
        DocumentRegistry reg = new DocumentRegistry(timelock, opsSafe);
        address t = makeAddr("token");
        vm.startPrank(opsSafe);
        uint256 a = reg.add(t, DocumentRegistry.DocType.TitleDeed, bytes32("a"), "docs://a");
        uint256 b = reg.add(t, DocumentRegistry.DocType.TitleDeed, bytes32("b"), "docs://b");
        uint256 c = reg.add(t, DocumentRegistry.DocType.TitleDeed, bytes32("c"), "docs://c");
        reg.supersede(b, c);
        vm.expectRevert(abi.encodeWithSelector(DocumentRegistry.InvalidSupersede.selector, a, b));
        reg.supersede(a, b); // b is no longer current
        vm.stopPrank();
    }

    function test_anchor_setterGuards() public {
        address owner = makeAddr("safe");
        StateAnchor anchor = new StateAnchor(owner, makeAddr("key"));
        vm.prank(owner);
        vm.expectRevert(Governed.ZeroAddress.selector);
        anchor.setAnchorer(address(0));
        vm.prank(makeAddr("stranger"));
        vm.expectRevert();
        anchor.setAnchorer(makeAddr("x"));
    }
}

/// Token that returns false instead of reverting, to exercise RecoveryGuard's defensive check.
contract FalseReturningToken {
    function forcedTransfer(address, address, uint256) external pure returns (bool) {
        return false;
    }

    function recoveryAddress(address, address, address) external pure returns (bool) {
        return false;
    }
}

contract RecoveryDefensiveCheckTest is Test {
    function test_executeRevertsIfTokenReportsFailure() public {
        address trustee = makeAddr("trustee");
        RecoveryGuard g = new RecoveryGuard(
            makeAddr("timelock"), IERC3643Token(address(new FalseReturningToken())), trustee, makeAddr("admin")
        );
        vm.startPrank(trustee);
        uint256 id =
            g.propose(RecoveryGuard.Kind.ForcedTransfer, makeAddr("a"), makeAddr("b"), address(0), 1, bytes32("e"));
        uint256 id2 = g.propose(
            RecoveryGuard.Kind.WalletRecovery, makeAddr("a"), makeAddr("b"), makeAddr("oid"), 0, bytes32("e")
        );
        vm.warp(vm.getBlockTimestamp() + g.RECOVERY_DELAY());
        vm.expectRevert(abi.encodeWithSelector(RecoveryGuard.ExecutionFailed.selector, id));
        g.execute(id);
        vm.expectRevert(abi.encodeWithSelector(RecoveryGuard.ExecutionFailed.selector, id2));
        g.execute(id2);
        vm.stopPrank();
    }
}
