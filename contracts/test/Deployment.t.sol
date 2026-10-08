// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Fixture} from "./helpers/Fixture.sol";
import {IOwnableV4, ITREXFactory, ITokenFull} from "../script/VendorInterfaces.sol";
import {Governed} from "../src/common/Governed.sol";
import {DeployLib} from "../script/DeployLib.sol";

/// @notice Post-deploy checks for invariants I-8 and I-9 (contract-spec.md section 8). The same
///         assertions run against the real deployment before go-live.
contract DeploymentTest is Fixture {
    function test_I9_everyProtocolContractIsOwnedByTimelock() public view {
        address tl = address(timelock);
        assertEq(token.owner(), tl, "token");
        assertEq(ir.owner(), tl, "identity registry");
        assertEq(IOwnableV4(ir.identityStorage()).owner(), tl, "identity storage");
        assertEq(IOwnableV4(ir.issuersRegistry()).owner(), tl, "issuers registry");
        assertEq(IOwnableV4(ir.topicsRegistry()).owner(), tl, "topics registry");
        assertEq(IOwnableV4(token.compliance()).owner(), tl, "compliance");
        assertEq(factory.owner(), tl, "factory");
        assertEq(issuance.owner(), tl, "issuance guard");
        assertEq(pauseGuard.owner(), tl, "pause guard");
        assertEq(freezeGuard.owner(), tl, "freeze guard");
        assertEq(recovery.owner(), tl, "recovery guard");
        assertEq(registrarGuard.owner(), tl, "registrar guard");
        assertEq(distributions.owner(), tl, "distribution registry");
        assertEq(documents.owner(), tl, "document registry");
    }

    function test_I9_upgradeAuthoritiesAndModulesOwnedByTimelock() public view {
        address tl = address(timelock);
        assertEq(IOwnableV4(deployment.trexAuthority).owner(), tl, "token implementation authority");
        assertEq(IOwnableV4(deployment.oidAuthority).owner(), tl, "identity implementation authority");
        assertEq(countryModule.owner(), tl, "country module");
        assertEq(maxBalanceModule.owner(), tl, "max balance module");
        assertEq(idFactory.owner(), identityOperator, "ID factory");
    }

    function test_claimIssuerManagedByManagerNotDeployer() public view {
        assertFalse(claimIssuer.keyHasPurpose(keccak256(abi.encode(address(this))), 1));
        assertTrue(claimIssuer.keyHasPurpose(keccak256(abi.encode(claimIssuerManager)), 1));
        assertTrue(claimIssuer.keyHasPurpose(keccak256(abi.encode(claimSigner)), 3));
    }

    function test_deployRefusesShortTimelock() public {
        DeployLib.Config memory c = config;
        c.timelockDelay = 72 hours - 1;
        c.salt = "SHORT";
        vm.expectRevert("DeployLib: timelock delay below 72h");
        this.deployExternal(c);
    }

    function test_shortTimelockOnlyOnLocalDevChain() public {
        DeployLib.Config memory c = config;
        c.timelockDelay = 60;

        // Any chain other than the local dev chain still requires 72h (Anvil, mainnet, staging...).
        uint256[3] memory chains = [uint256(1), 31_337, 586_587];
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            c.salt = string.concat("SHORT", vm.toString(i));
            vm.expectRevert("DeployLib: timelock delay below 72h");
            this.deployExternal(c);
        }

        vm.chainId(586_586);
        c.salt = "LOCALDEV";
        c.timelockDelay = 59;
        vm.expectRevert("DeployLib: timelock delay below 72h");
        this.deployExternal(c);
        c.timelockDelay = 60;
        this.deployExternal(c);
    }

    function deployExternal(DeployLib.Config memory c) external {
        DeployLib.deploy(c);
    }

    function test_I9_timelockDelayIsAtLeast72h() public view {
        assertGe(timelock.getMinDelay(), 72 hours);
    }

    function test_I9_deployerHasNoTimelockAdmin() public view {
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), address(this)));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), address(this)));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), trusteeSafe));
    }

    function test_I8_onlyGuardsAreTokenAgents() public view {
        assertTrue(token.isAgent(address(issuance)));
        assertTrue(token.isAgent(address(pauseGuard)));
        assertTrue(token.isAgent(address(freezeGuard)));
        assertTrue(token.isAgent(address(recovery)));

        address[8] memory notAgents =
            [address(this), adminSafe, trusteeSafe, issuanceSafe, opsSafe, pauser, registrar, identityOperator];
        for (uint256 i; i < notAgents.length; ++i) {
            assertFalse(token.isAgent(notAgents[i]), "unexpected token agent");
            assertFalse(ir.isAgent(notAgents[i]), "unexpected registry agent");
        }
        assertFalse(token.isAgent(address(timelock)), "timelock is never a token agent");
        assertTrue(ir.isAgent(address(timelock)), "timelock handles identity deletion");
        assertTrue(ir.isAgent(address(registrarGuard)));
        assertTrue(ir.isAgent(address(token)), "token must be IR agent for wallet recovery");
    }

    function test_freshTokenIsDeployedPaused() public {
        string memory salt = "SECOND";
        vm.prank(address(timelock));
        factory.deployTREXSuite(
            salt,
            ITREXFactory.TokenDetails({
                owner: address(timelock),
                name: "Second Property",
                symbol: "SEC2",
                decimals: 0,
                irs: address(0),
                ONCHAINID: address(0),
                irAgents: new address[](0),
                tokenAgents: new address[](0),
                complianceModules: new address[](0),
                complianceSettings: new bytes[](0)
            }),
            ITREXFactory.ClaimDetails({
                claimTopics: new uint256[](0), issuers: new address[](0), issuerClaims: new uint256[][](0)
            })
        );
        assertTrue(ITokenFull(factory.getToken(salt)).paused(), "new tokens start paused");
    }

    function test_deployerCannotMintOrPause() public {
        address investor = makeAddr("investor");
        _onboard(investor);
        vm.expectRevert();
        token.mint(investor, 1);
        vm.expectRevert();
        token.pause();
    }

    function test_renounceOwnershipIsDisabled() public {
        vm.prank(address(timelock));
        vm.expectRevert(Governed.RenounceDisabled.selector);
        issuance.renounceOwnership();
    }

    function test_ownershipTransferNeedsAcceptance() public {
        address next = makeAddr("nextTimelock");
        vm.prank(address(timelock));
        issuance.transferOwnership(next);
        assertEq(issuance.owner(), address(timelock), "owner changes only after accept");
        vm.prank(next);
        issuance.acceptOwnership();
        assertEq(issuance.owner(), next);
    }

    function test_trusteeCanCancelTimelockOperation() public {
        bytes memory data = abi.encodeWithSignature("transferOwnership(address)", makeAddr("attacker"));
        vm.prank(adminSafe);
        timelock.schedule(address(issuance), 0, data, bytes32(0), bytes32("x"), TIMELOCK_DELAY);
        bytes32 id = timelock.hashOperation(address(issuance), 0, data, bytes32(0), bytes32("x"));

        vm.prank(trusteeSafe);
        timelock.cancel(id);

        vm.warp(vm.getBlockTimestamp() + TIMELOCK_DELAY);
        vm.prank(adminSafe);
        vm.expectRevert();
        timelock.execute(address(issuance), 0, data, bytes32(0), bytes32("x"));
    }

    function test_timelockCannotExecuteEarly() public {
        bytes memory data = abi.encodeWithSignature("transferOwnership(address)", makeAddr("attacker"));
        vm.prank(adminSafe);
        timelock.schedule(address(issuance), 0, data, bytes32(0), bytes32("y"), TIMELOCK_DELAY);
        vm.warp(vm.getBlockTimestamp() + TIMELOCK_DELAY - 1);
        vm.prank(adminSafe);
        vm.expectRevert();
        timelock.execute(address(issuance), 0, data, bytes32(0), bytes32("y"));
    }
}
