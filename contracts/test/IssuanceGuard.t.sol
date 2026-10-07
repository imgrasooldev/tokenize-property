// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Fixture} from "./helpers/Fixture.sol";
import {Governed} from "../src/common/Governed.sol";
import {IssuanceGuard} from "../src/guards/IssuanceGuard.sol";
import {IERC3643Token} from "../src/interfaces/IERC3643.sol";

contract IssuanceGuardTest is Fixture {
    address internal alice = makeAddr("alice");
    address internal outsider = makeAddr("outsider");

    function setUp() public override {
        super.setUp();
        _onboard(alice);
    }

    function test_mint_byIssuanceSafe() public {
        vm.expectEmit(address(issuance));
        emit IssuanceGuard.Minted(alice, 100, bytes32("sub-1"));
        vm.prank(issuanceSafe);
        issuance.mint(alice, 100, bytes32("sub-1"));
        assertEq(token.balanceOf(alice), 100);
        assertTrue(issuance.refUsed(bytes32("sub-1")));
    }

    function test_mint_revertsForAnyoneElse() public {
        address[4] memory callers = [outsider, adminSafe, opsSafe, address(timelock)];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, callers[i]));
            issuance.mint(alice, 1, bytes32("x"));
        }
    }

    function test_I2_mint_cannotExceedTrusteeCap() public {
        vm.startPrank(issuanceSafe);
        issuance.mint(alice, INITIAL_CAP, bytes32("all"));
        vm.expectRevert(abi.encodeWithSelector(IssuanceGuard.CapExceeded.selector, INITIAL_CAP + 1, INITIAL_CAP));
        issuance.mint(alice, 1, bytes32("one-more"));
        vm.stopPrank();
    }

    function testFuzz_I2_mint_respectsCap(uint256 a, uint256 b) public {
        a = bound(a, 1, INITIAL_CAP);
        b = bound(b, 1, type(uint128).max);
        vm.startPrank(issuanceSafe);
        issuance.mint(alice, a, bytes32("a"));
        if (a + b > INITIAL_CAP) vm.expectRevert();
        issuance.mint(alice, b, bytes32("b"));
        vm.stopPrank();
        assertLe(token.totalSupply(), issuance.trusteeCap());
    }

    function test_I11_refId_usableOnce() public {
        vm.startPrank(issuanceSafe);
        issuance.mint(alice, 10, bytes32("sub-1"));
        vm.expectRevert(abi.encodeWithSelector(IssuanceGuard.RefAlreadyUsed.selector, bytes32("sub-1")));
        issuance.mint(alice, 10, bytes32("sub-1"));
        vm.expectRevert(abi.encodeWithSelector(IssuanceGuard.RefAlreadyUsed.selector, bytes32("sub-1")));
        issuance.burn(alice, 10, bytes32("sub-1"));
        vm.stopPrank();
    }

    function test_mint_rejectsZeroAmountAndZeroRef() public {
        vm.startPrank(issuanceSafe);
        vm.expectRevert(IssuanceGuard.ZeroAmount.selector);
        issuance.mint(alice, 0, bytes32("r"));
        vm.expectRevert(IssuanceGuard.InvalidRef.selector);
        issuance.mint(alice, 1, bytes32(0));
        vm.stopPrank();
    }

    function test_mint_refusedWhilePaused() public {
        vm.prank(pauser);
        pauseGuard.pause("incident");
        vm.prank(issuanceSafe);
        vm.expectRevert(IssuanceGuard.TokenPaused.selector);
        issuance.mint(alice, 1, bytes32("r"));
    }

    function test_I3_mint_toUnverifiedWalletReverts() public {
        vm.prank(issuanceSafe);
        vm.expectRevert("Identity is not verified.");
        issuance.mint(outsider, 1, bytes32("r"));
    }

    function test_burn() public {
        _mint(alice, 50);
        vm.prank(issuanceSafe);
        issuance.burn(alice, 20, bytes32("redeem-1"));
        assertEq(token.balanceOf(alice), 30);
        assertEq(token.totalSupply(), 30);
    }

    function test_setTrusteeCap_onlyTimelock() public {
        vm.prank(adminSafe);
        vm.expectRevert();
        issuance.setTrusteeCap(5);
    }

    function test_setTrusteeCap_cannotGoBelowSupply() public {
        _mint(alice, 500);
        vm.prank(address(timelock));
        vm.expectRevert(abi.encodeWithSelector(IssuanceGuard.CapBelowSupply.selector, 499, 500));
        issuance.setTrusteeCap(499);
    }

    function test_setIssuer_rotatesKey() public {
        address newIssuer = makeAddr("newIssuanceSafe");
        _timelockExec(address(issuance), abi.encodeCall(IssuanceGuard.setIssuer, (newIssuer)));
        vm.prank(issuanceSafe);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, issuanceSafe));
        issuance.mint(alice, 1, bytes32("r"));
        vm.prank(newIssuer);
        issuance.mint(alice, 1, bytes32("r"));
    }

    function test_constructor_rejectsZeroAddresses() public {
        IERC3643Token t = issuance.token();
        vm.expectRevert(Governed.ZeroAddress.selector);
        new IssuanceGuard(address(timelock), t, address(0));
    }
}
