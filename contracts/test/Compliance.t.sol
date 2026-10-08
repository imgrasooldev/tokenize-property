// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Fixture} from "./helpers/Fixture.sol";
import {IIdentity, IModularCompliance, IMaxBalanceModule} from "../script/VendorInterfaces.sol";
import {RecoveryGuard} from "../src/guards/RecoveryGuard.sol";

/// @notice Compliance modules from T-REX 4.1.6 (contract-spec.md section 4.3): country allow-list and
///         per-investor maximum balance.
contract ComplianceModulesTest is Fixture {
    uint16 internal constant USA = 840;
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal foreigner = makeAddr("foreigner");

    function setUp() public override {
        super.setUp();
        _onboard(alice);
        _onboard(bob);
        address id = _createVerifiedIdentity(foreigner);
        vm.prank(registrar);
        registrarGuard.register(foreigner, id, USA);
    }

    // ---------------------------------------------------------------- country allow-list

    function test_country_mintToDisallowedCountryReverts() public {
        vm.prank(issuanceSafe);
        vm.expectRevert("Compliance not followed");
        issuance.mint(foreigner, 1, bytes32("r"));
    }

    function test_country_transferToDisallowedCountryReverts() public {
        _mint(alice, 10);
        vm.prank(alice);
        vm.expectRevert("Transfer not possible");
        token.transfer(foreigner, 1);
    }

    function test_country_allowListChangesOnlyThroughTimelock() public {
        IModularCompliance mc = IModularCompliance(token.compliance());
        uint16[] memory countries = new uint16[](1);
        countries[0] = USA;
        bytes memory call = abi.encodeWithSignature("batchAllowCountries(uint16[])", countries);

        vm.prank(adminSafe);
        vm.expectRevert("Ownable: caller is not the owner");
        mc.callModuleFunction(call, address(countryModule));

        _timelockExec(
            address(mc), abi.encodeCall(IModularCompliance.callModuleFunction, (call, address(countryModule)))
        );
        assertTrue(countryModule.isCountryAllowed(address(mc), USA));
        _mint(foreigner, 1);
    }

    // ---------------------------------------------------------------- max balance

    function test_maxBalance_mintAboveLimitReverts() public {
        _mint(alice, MAX_BALANCE);
        vm.prank(issuanceSafe);
        vm.expectRevert("Compliance not followed");
        issuance.mint(alice, 1, bytes32("over"));
    }

    function test_maxBalance_transferAboveLimitReverts() public {
        _mint(alice, MAX_BALANCE);
        _mint(bob, 10);
        vm.prank(bob);
        vm.expectRevert("Transfer not possible");
        token.transfer(alice, 1);
    }

    function test_maxBalance_countsAllWalletsOfOneIdentity() public {
        // A second wallet linked to Alice's ONCHAINID shares her limit: no splitting across wallets.
        address aliceSecond = makeAddr("aliceSecond");
        vm.prank(alice);
        IIdentity(identityOf[alice]).addKey(keccak256(abi.encode(aliceSecond)), 1, 1);
        vm.prank(registrar);
        registrarGuard.register(aliceSecond, identityOf[alice], PAKISTAN);

        _mint(alice, MAX_BALANCE - 5);
        vm.prank(issuanceSafe);
        vm.expectRevert("Compliance not followed");
        issuance.mint(aliceSecond, 6, bytes32("split"));
        _mint(aliceSecond, 5);
        assertEq(maxBalanceModule.getIDBalance(token.compliance(), identityOf[alice]), MAX_BALANCE);
    }

    function test_maxBalance_trackingMatchesBalances() public {
        _mint(alice, 700);
        _mint(bob, 300);
        vm.prank(alice);
        token.transfer(bob, 200);
        vm.prank(issuanceSafe);
        issuance.burn(bob, 100, bytes32("redeem"));
        address mc = token.compliance();
        assertEq(maxBalanceModule.getIDBalance(mc, identityOf[alice]), token.balanceOf(alice));
        assertEq(maxBalanceModule.getIDBalance(mc, identityOf[bob]), token.balanceOf(bob));
    }

    function test_maxBalance_limitChangesOnlyThroughTimelock() public {
        IModularCompliance mc = IModularCompliance(token.compliance());
        bytes memory call = abi.encodeCall(IMaxBalanceModule.setMaxBalance, (MAX_BALANCE * 2));
        vm.prank(adminSafe);
        vm.expectRevert("Ownable: caller is not the owner");
        mc.callModuleFunction(call, address(maxBalanceModule));

        vm.prank(adminSafe);
        vm.expectRevert("only bound compliance can call");
        maxBalanceModule.setMaxBalance(MAX_BALANCE * 2);
    }

    // ---------------------------------------------------------------- module upgrade keys

    function test_modules_onlyTimelockCanUpgrade() public {
        address evil = makeAddr("evilImplementation");
        address[3] memory callers = [address(this), adminSafe, opsSafe];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            vm.expectRevert("Ownable: caller is not the owner");
            countryModule.upgradeTo(evil);
            vm.expectRevert("Ownable: caller is not the owner");
            maxBalanceModule.upgradeTo(evil);
            vm.stopPrank();
        }
        assertEq(countryModule.owner(), address(timelock));
        assertEq(maxBalanceModule.owner(), address(timelock));
    }
}

/// @notice Operational hazards found while reviewing MaxBalanceModule (finding F-02). The module tracks
///         balances per ONCHAINID and looks the identity up on every burn and transfer. These tests prove
///         the hazards and the safe procedures written into contract-spec.md section 4.2.
contract OffboardingProcedureTest is Fixture {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    bytes32 internal constant CASE = bytes32("AML-CASE-9");

    function setUp() public override {
        super.setUp();
        _onboard(alice);
        _onboard(bob);
        _mint(alice, 100);
    }

    function test_F02_hazard_deletingIdentityWithBalanceStrandsTokens() public {
        _timelockExec(address(ir), abi.encodeWithSignature("deleteIdentity(address)", alice));
        vm.prank(issuanceSafe);
        vm.expectRevert("identity not found");
        issuance.burn(alice, 100, bytes32("redeem"));
    }

    function test_F02_hazard_updatingIdentityWithBalanceStrandsTokens() public {
        address newIdentity = _createVerifiedIdentity(makeAddr("aliceNewId"));
        _timelockExec(address(ir), abi.encodeWithSignature("updateIdentity(address,address)", alice, newIdentity));
        vm.prank(alice);
        vm.expectRevert(); // arithmetic underflow in MaxBalanceModule
        token.transfer(bob, 1);
    }

    /// Safe offboarding: freeze now, move or redeem the tokens, and only then delete the identity.
    function test_F02_safeOffboarding() public {
        vm.prank(opsSafe);
        freezeGuard.freezeAddress(alice, CASE);

        // Court-ordered move to a verified escrow investor (or a redemption burn via IssuanceGuard).
        vm.prank(trusteeSafe);
        uint256 id =
            recovery.propose(RecoveryGuard.Kind.ForcedTransfer, alice, bob, address(0), 100, keccak256("court-order"));
        vm.warp(vm.getBlockTimestamp() + recovery.RECOVERY_DELAY());
        vm.prank(trusteeSafe);
        recovery.execute(id);
        assertEq(token.balanceOf(alice), 0);

        _timelockExec(address(ir), abi.encodeWithSignature("deleteIdentity(address)", alice));
        assertFalse(ir.contains(alice));
        assertEq(token.balanceOf(bob), 100);
        assertEq(maxBalanceModule.getIDBalance(token.compliance(), identityOf[bob]), 100);
    }
}
