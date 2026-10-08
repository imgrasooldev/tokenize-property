// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Fixture} from "./helpers/Fixture.sol";
import {IAgentRole} from "../script/VendorInterfaces.sol";
import {Governed} from "../src/common/Governed.sol";
import {RegistrarGuard} from "../src/guards/RegistrarGuard.sol";
import {IERC3643IdentityRegistry} from "../src/interfaces/IERC3643.sol";

contract RegistrarGuardTest is Fixture {
    RegistrarGuard internal small;
    uint256 internal constant SMALL_LIMIT = 3;
    uint256 private _walletNonce;

    function setUp() public override {
        super.setUp();
        // A second guard with a small limit, added as registry agent through the timelock.
        small = new RegistrarGuard(address(timelock), IERC3643IdentityRegistry(address(ir)), registrar, SMALL_LIMIT);
        _timelockExec(address(ir), abi.encodeCall(IAgentRole.addAgent, (address(small))));
    }

    function _freshVerified() internal returns (address wallet, address identity) {
        wallet = makeAddr(string.concat("investor", vm.toString(++_walletNonce)));
        identity = _createVerifiedIdentity(wallet);
    }

    function test_registersVerifiedInvestor() public {
        (address wallet, address identity) = _freshVerified();
        vm.prank(registrar);
        registrarGuard.register(wallet, identity, PAKISTAN);
        assertTrue(ir.isVerified(wallet));
        assertEq(ir.identity(wallet), identity);
    }

    function test_rejectsIdentityWithoutClaims() public {
        address wallet = makeAddr("noClaims");
        vm.prank(identityOperator);
        address identity = idFactory.createIdentity(wallet, "no-claims");
        vm.prank(registrar);
        vm.expectRevert(abi.encodeWithSelector(RegistrarGuard.NotVerified.selector, wallet));
        registrarGuard.register(wallet, identity, PAKISTAN);
        assertFalse(ir.contains(wallet), "nothing registered");
    }

    function test_rejectsIdentityWithOnlyOneOfTwoClaims() public {
        address wallet = makeAddr("kycOnly");
        vm.prank(identityOperator);
        address identity = idFactory.createIdentity(wallet, "kyc-only");
        _addClaim(wallet, identity, TOPIC_KYC);
        vm.prank(registrar);
        vm.expectRevert(abi.encodeWithSelector(RegistrarGuard.NotVerified.selector, wallet));
        registrarGuard.register(wallet, identity, PAKISTAN);
    }

    function test_onlyRegistrar() public {
        (address wallet, address identity) = _freshVerified();
        vm.prank(opsSafe);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, opsSafe));
        registrarGuard.register(wallet, identity, PAKISTAN);
    }

    function test_I12_rateLimitBlocksBurst() public {
        for (uint256 i; i < SMALL_LIMIT; ++i) {
            (address w, address id) = _freshVerified();
            vm.prank(registrar);
            small.register(w, id, PAKISTAN);
        }
        assertEq(small.recentRegistrations(), SMALL_LIMIT);

        (address wallet, address identity) = _freshVerified();
        vm.prank(registrar);
        vm.expectRevert(abi.encodeWithSelector(RegistrarGuard.RateLimited.selector, vm.getBlockTimestamp() + 1 hours));
        small.register(wallet, identity, PAKISTAN);
    }

    function test_I12_windowSlides() public {
        // Spread registrations: t=0, t=20m, t=40m. At t=60m the first slot frees up, not all three.
        uint256 start = vm.getBlockTimestamp();
        for (uint256 i; i < SMALL_LIMIT; ++i) {
            vm.warp(start + i * 20 minutes);
            (address w, address id) = _freshVerified();
            vm.prank(registrar);
            small.register(w, id, PAKISTAN);
        }

        vm.warp(start + 60 minutes);
        (address a, address aId) = _freshVerified();
        vm.prank(registrar);
        small.register(a, aId, PAKISTAN);

        (address b, address bId) = _freshVerified();
        vm.prank(registrar);
        vm.expectRevert(abi.encodeWithSelector(RegistrarGuard.RateLimited.selector, start + 80 minutes));
        small.register(b, bId, PAKISTAN);
    }

    function testFuzz_I12_neverMoreThanLimitPerHour(uint8[12] memory gapsMinutes) public {
        uint256[] memory accepted = new uint256[](12);
        uint256 n;
        for (uint256 i; i < gapsMinutes.length; ++i) {
            vm.warp(vm.getBlockTimestamp() + uint256(gapsMinutes[i] % 40) * 1 minutes);
            (address w, address id) = _freshVerified();
            vm.prank(registrar);
            try small.register(w, id, PAKISTAN) {
                accepted[n++] = vm.getBlockTimestamp();
            } catch {}
        }
        // Any SMALL_LIMIT + 1 consecutive accepted registrations must span at least one hour.
        for (uint256 i = SMALL_LIMIT; i < n; ++i) {
            assertGe(accepted[i] - accepted[i - SMALL_LIMIT], 1 hours);
        }
    }

    function test_constructorBounds() public {
        IERC3643IdentityRegistry r = IERC3643IdentityRegistry(address(ir));
        vm.expectRevert(RegistrarGuard.InvalidLimit.selector);
        new RegistrarGuard(address(timelock), r, registrar, 0);
        vm.expectRevert(RegistrarGuard.InvalidLimit.selector);
        new RegistrarGuard(address(timelock), r, registrar, 501);
    }
}
