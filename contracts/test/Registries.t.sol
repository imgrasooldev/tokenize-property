// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Governed} from "../src/common/Governed.sol";
import {DistributionRegistry} from "../src/registries/DistributionRegistry.sol";
import {DocumentRegistry} from "../src/registries/DocumentRegistry.sol";
import {StateAnchor} from "../src/anchor/StateAnchor.sol";

contract DistributionRegistryTest is Test {
    DistributionRegistry internal reg;
    address internal timelock = makeAddr("timelock");
    address internal opsSafe = makeAddr("opsSafe");
    address internal trusteeSafe = makeAddr("trusteeSafe");
    address internal token = makeAddr("token");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant ALICE_PAISA = 1_250_000; // Rs 12,500
    uint256 internal constant BOB_PAISA = 750_000; // Rs 7,500
    bytes32 internal aliceLeaf;
    bytes32 internal bobLeaf;
    bytes32 internal root;

    function setUp() public {
        reg = new DistributionRegistry(timelock, opsSafe, trusteeSafe);
        vm.roll(100);
        aliceLeaf = keccak256(bytes.concat(keccak256(abi.encode(alice, ALICE_PAISA))));
        bobLeaf = keccak256(bytes.concat(keccak256(abi.encode(bob, BOB_PAISA))));
        // Two-leaf tree: root = hash of the sorted pair (OpenZeppelin commutative hashing).
        root = aliceLeaf < bobLeaf
            ? keccak256(abi.encodePacked(aliceLeaf, bobLeaf))
            : keccak256(abi.encodePacked(bobLeaf, aliceLeaf));
    }

    function _publish() internal returns (uint256 id) {
        vm.prank(opsSafe);
        id = reg.publish(token, 99, root, ALICE_PAISA + BOB_PAISA, keccak256("statement-2026-09"));
    }

    function test_fullLifecycle() public {
        uint256 id = _publish();
        vm.warp(vm.getBlockTimestamp() + reg.CHALLENGE_WINDOW());
        reg.finalize(id); // anyone may finalize
        vm.prank(opsSafe);
        reg.recordPayout(id, keccak256("bank-batch-0912"));
        DistributionRegistry.Distribution memory d = reg.getDistribution(id);
        assertEq(uint8(d.status), uint8(DistributionRegistry.Status.Paid));
        assertEq(d.payoutBatchHash, keccak256("bank-batch-0912"));
    }

    function test_investorCanVerifyOwnEntitlement() public {
        uint256 id = _publish();
        bytes32[] memory proof = new bytes32[](1);
        proof[0] = bobLeaf;
        assertTrue(reg.verify(id, alice, ALICE_PAISA, proof));
        assertFalse(reg.verify(id, alice, ALICE_PAISA + 1, proof), "wrong amount");
        assertFalse(reg.verify(id, bob, ALICE_PAISA, proof), "wrong account");
        assertFalse(reg.verify(id + 1, alice, ALICE_PAISA, proof), "unknown distribution");
    }

    function test_I14_idsStrictlyIncrease() public {
        uint256 a = _publish();
        uint256 b = _publish();
        assertEq(b, a + 1);
    }

    function test_I14_trusteeRejectsWithinWindow() public {
        uint256 id = _publish();
        vm.prank(trusteeSafe);
        reg.reject(id, "root does not match register");
        vm.warp(vm.getBlockTimestamp() + reg.CHALLENGE_WINDOW());
        vm.expectRevert(
            abi.encodeWithSelector(DistributionRegistry.WrongStatus.selector, id, DistributionRegistry.Status.Rejected)
        );
        reg.finalize(id);
    }

    function test_I14_cannotRejectAfterWindow() public {
        uint256 id = _publish();
        vm.warp(vm.getBlockTimestamp() + reg.CHALLENGE_WINDOW());
        vm.prank(trusteeSafe);
        vm.expectRevert(abi.encodeWithSelector(DistributionRegistry.WindowClosed.selector, id));
        reg.reject(id, "late");
    }

    function test_I14_cannotFinalizeEarly() public {
        uint256 id = _publish();
        uint256 closesAt = vm.getBlockTimestamp() + reg.CHALLENGE_WINDOW();
        vm.warp(closesAt - 1);
        vm.expectRevert(abi.encodeWithSelector(DistributionRegistry.WindowOpen.selector, id, closesAt));
        reg.finalize(id);
    }

    function test_I14_payoutOnlyOnceAndOnlyWhenFinalized() public {
        uint256 id = _publish();
        vm.prank(opsSafe);
        vm.expectRevert(
            abi.encodeWithSelector(DistributionRegistry.WrongStatus.selector, id, DistributionRegistry.Status.Published)
        );
        reg.recordPayout(id, keccak256("batch"));

        vm.warp(vm.getBlockTimestamp() + reg.CHALLENGE_WINDOW());
        reg.finalize(id);
        vm.startPrank(opsSafe);
        reg.recordPayout(id, keccak256("batch"));
        vm.expectRevert(
            abi.encodeWithSelector(DistributionRegistry.WrongStatus.selector, id, DistributionRegistry.Status.Paid)
        );
        reg.recordPayout(id, keccak256("batch-2"));
        vm.stopPrank();
    }

    function test_rejectsInvalidPublish() public {
        bytes32 st = keccak256("s");
        vm.startPrank(opsSafe);
        vm.expectRevert(DistributionRegistry.InvalidDistribution.selector);
        reg.publish(address(0), 99, root, 1, st);
        vm.expectRevert(DistributionRegistry.InvalidDistribution.selector);
        reg.publish(token, 100, root, 1, st); // record block not in the past
        vm.expectRevert(DistributionRegistry.InvalidDistribution.selector);
        reg.publish(token, 99, bytes32(0), 1, st);
        vm.expectRevert(DistributionRegistry.InvalidDistribution.selector);
        reg.publish(token, 99, root, 0, st);
        vm.expectRevert(DistributionRegistry.InvalidDistribution.selector);
        reg.publish(token, 99, root, 1, bytes32(0));
        vm.stopPrank();
    }

    function test_roles() public {
        vm.prank(trusteeSafe);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, trusteeSafe));
        reg.publish(token, 99, root, 1, keccak256("s"));

        uint256 id = _publish();
        vm.prank(opsSafe);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, opsSafe));
        reg.reject(id, "ops cannot reject");
    }
}

contract DocumentRegistryTest is Test {
    DocumentRegistry internal reg;
    address internal timelock = makeAddr("timelock");
    address internal opsSafe = makeAddr("opsSafe");
    address internal token = makeAddr("token");
    address internal otherToken = makeAddr("otherToken");

    function setUp() public {
        reg = new DocumentRegistry(timelock, opsSafe);
    }

    function _add(address t, string memory name) internal returns (uint256) {
        // Compute arguments first: sha256 is a precompile call and would consume the prank.
        bytes32 hash = sha256(bytes(name));
        string memory uri = string.concat("docs://", name);
        vm.prank(opsSafe);
        return reg.add(t, DocumentRegistry.DocType.Valuation, hash, uri);
    }

    function test_addAndRead() public {
        uint256 id = _add(token, "valuation-2026.pdf");
        DocumentRegistry.Document memory d = reg.getDocument(id);
        assertEq(d.token, token);
        assertEq(d.sha256Hash, sha256(bytes("valuation-2026.pdf")));
        assertEq(d.supersededBy, 0);
    }

    function test_I15_supersedeKeepsOldRecord() public {
        uint256 oldId = _add(token, "v1");
        uint256 newId = _add(token, "v2");
        vm.prank(opsSafe);
        reg.supersede(oldId, newId);
        DocumentRegistry.Document memory d = reg.getDocument(oldId);
        assertEq(d.supersededBy, newId);
        assertEq(d.sha256Hash, sha256(bytes("v1")), "old hash untouched");
    }

    function test_I15_invalidSupersedes() public {
        uint256 a = _add(token, "a");
        uint256 b = _add(token, "b");
        uint256 c = _add(otherToken, "c");
        vm.startPrank(opsSafe);
        vm.expectRevert(abi.encodeWithSelector(DocumentRegistry.InvalidSupersede.selector, a, a));
        reg.supersede(a, a);
        vm.expectRevert(abi.encodeWithSelector(DocumentRegistry.InvalidSupersede.selector, a, c));
        reg.supersede(a, c); // different token
        vm.expectRevert(abi.encodeWithSelector(DocumentRegistry.InvalidSupersede.selector, 99, b));
        reg.supersede(99, b); // unknown
        reg.supersede(a, b);
        vm.expectRevert(abi.encodeWithSelector(DocumentRegistry.InvalidSupersede.selector, a, b));
        reg.supersede(a, b); // already superseded
        vm.stopPrank();
    }

    function test_rejectsInvalidDocuments() public {
        vm.startPrank(opsSafe);
        vm.expectRevert(DocumentRegistry.InvalidDocument.selector);
        reg.add(address(0), DocumentRegistry.DocType.Other, bytes32("h"), "u");
        vm.expectRevert(DocumentRegistry.InvalidDocument.selector);
        reg.add(token, DocumentRegistry.DocType.Other, bytes32(0), "u");
        vm.expectRevert(DocumentRegistry.InvalidDocument.selector);
        reg.add(token, DocumentRegistry.DocType.Other, bytes32("h"), "");
        bytes memory longUri = new bytes(513);
        vm.expectRevert(DocumentRegistry.InvalidDocument.selector);
        reg.add(token, DocumentRegistry.DocType.Other, bytes32("h"), string(longUri));
        vm.stopPrank();
    }

    function test_onlyOps() public {
        vm.prank(timelock);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, timelock));
        reg.add(token, DocumentRegistry.DocType.Other, bytes32("h"), "u");
    }
}

contract StateAnchorTest is Test {
    StateAnchor internal anchor;
    address internal owner = makeAddr("publicChainSafe");
    address internal anchorer = makeAddr("anchorKey");

    function setUp() public {
        anchor = new StateAnchor(owner, anchorer);
    }

    function test_anchors() public {
        vm.prank(anchorer);
        anchor.anchor(1800, keccak256("block-1800"));
        assertEq(anchor.anchors(1800), keccak256("block-1800"));
        assertEq(anchor.lastAnchoredBlock(), 1800);
    }

    function test_I16_blocksStrictlyIncrease() public {
        vm.startPrank(anchorer);
        anchor.anchor(1800, keccak256("a"));
        vm.expectRevert(abi.encodeWithSelector(StateAnchor.NotIncreasing.selector, 1800, 1800));
        anchor.anchor(1800, keccak256("rewrite"));
        vm.expectRevert(abi.encodeWithSelector(StateAnchor.NotIncreasing.selector, 1799, 1800));
        anchor.anchor(1799, keccak256("older"));
        vm.stopPrank();
        assertEq(anchor.anchors(1800), keccak256("a"), "never overwritten");
    }

    function testFuzz_I16_monotonic(uint64[8] memory blocks) public {
        uint64 last;
        for (uint256 i; i < blocks.length; ++i) {
            vm.prank(anchorer);
            try anchor.anchor(blocks[i], keccak256(abi.encode(i))) {
                assertGt(blocks[i], last);
                last = blocks[i];
            } catch {
                assertLe(blocks[i], last);
            }
        }
        assertEq(anchor.lastAnchoredBlock(), last);
    }

    function test_rejectsZeroHashAndOutsiders() public {
        vm.prank(anchorer);
        vm.expectRevert(StateAnchor.ZeroHash.selector);
        anchor.anchor(1, bytes32(0));
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, owner));
        anchor.anchor(1, keccak256("x"));
    }

    function test_ownerRotatesAnchorKey() public {
        address next = makeAddr("nextAnchorKey");
        vm.prank(owner);
        anchor.setAnchorer(next);
        vm.prank(anchorer);
        vm.expectRevert(abi.encodeWithSelector(Governed.Unauthorized.selector, anchorer));
        anchor.anchor(1, keccak256("x"));
    }
}
