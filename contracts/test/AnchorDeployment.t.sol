// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {DeployLib} from "../script/DeployLib.sol";
import {StateAnchor} from "../src/anchor/StateAnchor.sol";
import {Governed} from "../src/common/Governed.sol";

/// @dev Stands in for the Safe on the public chain: any contract with code.
contract SafeStub {}

/// @notice Deployment of the public-chain anchor through DeployLib and its post-deploy check
///         (contract-spec.md section 7.2), plus the anchor commitment format (section 7.1).
contract AnchorDeploymentTest is Test {
    uint256 internal constant L2_CHAIN_ID = 8453;
    address internal deployer = makeAddr("deployer");
    address internal anchorer = makeAddr("anchorKey");
    address internal safe;

    function setUp() public {
        safe = address(new SafeStub());
        vm.chainId(L2_CHAIN_ID);
    }

    function _config() internal view returns (DeployLib.AnchorConfig memory) {
        return DeployLib.AnchorConfig({deployer: deployer, owner: safe, anchorer: anchorer});
    }

    function deployExternal(DeployLib.AnchorConfig memory c) external returns (StateAnchor) {
        return DeployLib.deployAnchor(c);
    }

    function checkExternal(DeployLib.AnchorConfig memory c, StateAnchor a) external view {
        DeployLib.checkAnchor(c, a);
    }

    function test_deployAndCheckOnPublicChain() public {
        DeployLib.AnchorConfig memory c = _config();
        vm.prank(deployer);
        StateAnchor a = this.deployExternal(c);
        this.checkExternal(c, a);
        assertEq(a.owner(), safe);
        assertEq(a.anchorer(), anchorer);
        assertEq(a.lastAnchoredBlock(), 0);
    }

    function test_deployerHoldsNoPower() public {
        DeployLib.AnchorConfig memory c = _config();
        StateAnchor a = this.deployExternal(c);
        vm.startPrank(deployer);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, deployer));
        a.anchor(1, keccak256("x"));
        vm.expectRevert();
        a.setAnchorer(deployer);
        vm.expectRevert();
        a.transferOwnership(deployer);
        vm.stopPrank();
    }

    function test_neverOnThePrivateChain() public {
        vm.chainId(DeployLib.LOCAL_DEV_CHAIN_ID);
        vm.expectRevert("DeployLib: anchor must not live on the private chain");
        this.deployExternal(_config());
    }

    function test_checkRefusesThePrivateChain() public {
        DeployLib.AnchorConfig memory c = _config();
        StateAnchor a = this.deployExternal(c);
        vm.chainId(DeployLib.LOCAL_DEV_CHAIN_ID);
        vm.expectRevert("anchor: on the private chain");
        this.checkExternal(c, a);
    }

    function test_ownerMustBeASafeOnPublicChains() public {
        DeployLib.AnchorConfig memory c = _config();
        c.owner = makeAddr("eoaOwner");
        StateAnchor a = this.deployExternal(c);
        vm.expectRevert("anchor: owner must be a Safe");
        this.checkExternal(c, a);
    }

    function test_localStandInAcceptsPlainOwner() public {
        vm.chainId(DeployLib.LOCAL_ANCHOR_CHAIN_ID);
        DeployLib.AnchorConfig memory c = _config();
        c.owner = makeAddr("standInSafe");
        StateAnchor a = this.deployExternal(c);
        this.checkExternal(c, a);
    }

    function test_checkFindsWrongOwnerOrKey() public {
        DeployLib.AnchorConfig memory c = _config();
        StateAnchor a = this.deployExternal(c);

        DeployLib.AnchorConfig memory wrong = _config();
        wrong.owner = address(new SafeStub());
        vm.expectRevert("anchor: owner");
        this.checkExternal(wrong, a);

        wrong = _config();
        wrong.anchorer = makeAddr("otherKey");
        vm.expectRevert("anchor: anchor key");
        this.checkExternal(wrong, a);
    }

    function test_checkFindsPendingOwner() public {
        DeployLib.AnchorConfig memory c = _config();
        StateAnchor a = this.deployExternal(c);
        vm.prank(safe);
        a.transferOwnership(makeAddr("next"));
        vm.expectRevert("anchor: pending owner");
        this.checkExternal(c, a);
    }

    function test_checkFindsUsedAnchor() public {
        DeployLib.AnchorConfig memory c = _config();
        StateAnchor a = this.deployExternal(c);
        vm.prank(anchorer);
        a.anchor(1, keccak256("x"));
        vm.expectRevert("anchor: not fresh");
        this.checkExternal(c, a);
    }

    function test_keysMustDiffer() public {
        address[3][3] memory cases = [[safe, safe, anchorer], [anchorer, safe, anchorer], [deployer, safe, safe]];
        for (uint256 i; i < cases.length; ++i) {
            DeployLib.AnchorConfig memory c =
                DeployLib.AnchorConfig({deployer: cases[i][0], owner: cases[i][1], anchorer: cases[i][2]});
            StateAnchor a = this.deployExternal(c);
            vm.expectRevert("anchor: keys must differ");
            this.checkExternal(c, a);
        }
    }

    /// @notice Fixed test vector for the v1 commitment (section 7.1); backend/packages/anchor checks
    ///         the same value, so both sides encode it identically.
    function test_commitmentVector() public pure {
        bytes32 commitment = keccak256(
            abi.encode(
                keccak256("property-token/state-anchor/v1"),
                uint256(586_586),
                uint64(1800),
                keccak256("besu-block-1800"),
                uint64(42),
                sha256("ledger-head-42")
            )
        );
        assertEq(commitment, COMMITMENT_VECTOR);
    }

    bytes32 internal constant COMMITMENT_VECTOR = 0xd37e43dfa7699fa914302afe3161b28b7802f869ee6bad9fc27f5532706e6906;
}
