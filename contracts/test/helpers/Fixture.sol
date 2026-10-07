// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {IERC3643Token, IERC3643IdentityRegistry} from "../../src/interfaces/IERC3643.sol";
import {IssuanceGuard} from "../../src/guards/IssuanceGuard.sol";
import {PauseGuard} from "../../src/guards/PauseGuard.sol";
import {FreezeGuard} from "../../src/guards/FreezeGuard.sol";
import {RecoveryGuard} from "../../src/guards/RecoveryGuard.sol";
import {RegistrarGuard} from "../../src/guards/RegistrarGuard.sol";
import {DistributionRegistry} from "../../src/registries/DistributionRegistry.sol";
import {DocumentRegistry} from "../../src/registries/DocumentRegistry.sol";

import {
    ITokenFull,
    IIdentityRegistryFull,
    ITREXImplementationAuthority,
    ITREXFactory,
    IIdFactory,
    IIdentity,
    IClaimIssuer,
    IOwnableV4
} from "./VendorInterfaces.sol";

/// @notice Deploys the full system the way production will: ERC-3643 suite through the official
///         factory, guards as the only agents, everything owned by a 72h TimelockController, and
///         deployer powers handed over (contract-spec.md section 9).
abstract contract Fixture is Test {
    uint256 internal constant TIMELOCK_DELAY = 72 hours;
    uint256 internal constant TOPIC_KYC = 1;
    uint256 internal constant TOPIC_AML = 2;
    uint16 internal constant PAKISTAN = 586;
    uint256 internal constant INITIAL_CAP = 1_000_000;
    uint256 internal constant MAX_PER_HOUR = 50;
    string internal constant SALT = "GPF3";

    // Actors (Safes are plain addresses in tests; production uses Safe multisigs).
    address internal adminSafe = makeAddr("adminSafe");
    address internal trusteeSafe = makeAddr("trusteeSafe");
    address internal issuanceSafe = makeAddr("issuanceSafe");
    address internal opsSafe = makeAddr("opsSafe");
    address internal pauser = makeAddr("pauser");
    address internal registrar = makeAddr("registrar");
    address internal identityOperator = makeAddr("identityOperator");
    address internal claimIssuerManager = makeAddr("claimIssuerManager");
    address internal claimSigner;
    uint256 internal claimSignerKey;

    // System.
    TimelockController internal timelock;
    ITREXFactory internal factory;
    IIdFactory internal idFactory;
    IClaimIssuer internal claimIssuer;
    ITokenFull internal token;
    IIdentityRegistryFull internal ir;

    IssuanceGuard internal issuance;
    PauseGuard internal pauseGuard;
    FreezeGuard internal freezeGuard;
    RecoveryGuard internal recovery;
    RegistrarGuard internal registrarGuard;
    DistributionRegistry internal distributions;
    DocumentRegistry internal documents;

    mapping(address wallet => address identity) internal identityOf;
    uint256 private _saltNonce;
    uint256 private _opNonce;

    function setUp() public virtual {
        (claimSigner, claimSignerKey) = makeAddrAndKey("claimSigner");
        _deployTimelock();
        _deploySuite();
        _deployGuards();
        _handOver();
        _timelockExec(address(issuance), abi.encodeCall(IssuanceGuard.setTrusteeCap, (INITIAL_CAP)));
        // ERC-3643 tokens are deployed paused. Go-live is the Admin Safe unpausing after all checks pass.
        vm.prank(adminSafe);
        pauseGuard.unpause();
    }

    // ---------------------------------------------------------------- deployment

    function _deployTimelock() private {
        address[] memory proposers = new address[](1);
        proposers[0] = adminSafe;
        address[] memory executors = new address[](1);
        executors[0] = adminSafe;
        timelock = new TimelockController(TIMELOCK_DELAY, proposers, executors, address(this));
        timelock.grantRole(timelock.CANCELLER_ROLE(), trusteeSafe);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), address(this));
    }

    function _deploySuite() private {
        address identityImpl = deployCode("Identity.sol:Identity", abi.encode(address(this), true));
        address oidAuthority =
            deployCode("ImplementationAuthority.sol:ImplementationAuthority", abi.encode(identityImpl));
        idFactory = IIdFactory(deployCode("IdFactory.sol:IdFactory", abi.encode(oidAuthority)));

        ITREXImplementationAuthority.TREXContracts memory impls = ITREXImplementationAuthority.TREXContracts({
            tokenImplementation: deployCode("Token.sol:Token"),
            ctrImplementation: deployCode("ClaimTopicsRegistry.sol:ClaimTopicsRegistry"),
            irImplementation: deployCode("IdentityRegistry.sol:IdentityRegistry"),
            irsImplementation: deployCode("IdentityRegistryStorage.sol:IdentityRegistryStorage"),
            tirImplementation: deployCode("TrustedIssuersRegistry.sol:TrustedIssuersRegistry"),
            mcImplementation: deployCode("ModularCompliance.sol:ModularCompliance")
        });
        address trexAuthority = deployCode(
            "TREXImplementationAuthority.sol:TREXImplementationAuthority", abi.encode(true, address(0), address(0))
        );
        ITREXImplementationAuthority(trexAuthority)
            .addAndUseTREXVersion(ITREXImplementationAuthority.Version(4, 1, 3), impls);

        factory = ITREXFactory(deployCode("TREXFactory.sol:TREXFactory", abi.encode(trexAuthority, address(idFactory))));
        idFactory.addTokenFactory(address(factory));

        claimIssuer = IClaimIssuer(deployCode("ClaimIssuer.sol:ClaimIssuer", abi.encode(claimIssuerManager)));
        vm.prank(claimIssuerManager);
        claimIssuer.addKey(keccak256(abi.encode(claimSigner)), 3, 1);

        uint256[] memory topics = new uint256[](2);
        topics[0] = TOPIC_KYC;
        topics[1] = TOPIC_AML;
        address[] memory issuers = new address[](1);
        issuers[0] = address(claimIssuer);
        uint256[][] memory issuerClaims = new uint256[][](1);
        issuerClaims[0] = topics;

        factory.deployTREXSuite(
            SALT,
            ITREXFactory.TokenDetails({
                owner: address(this),
                name: "Gulberg Plaza Floor 3",
                symbol: "GPF3",
                decimals: 0,
                irs: address(0),
                ONCHAINID: address(0),
                irAgents: new address[](0),
                tokenAgents: new address[](0),
                complianceModules: new address[](0),
                complianceSettings: new bytes[](0)
            }),
            ITREXFactory.ClaimDetails({claimTopics: topics, issuers: issuers, issuerClaims: issuerClaims})
        );
        token = ITokenFull(factory.getToken(SALT));
        ir = IIdentityRegistryFull(token.identityRegistry());
    }

    function _deployGuards() private {
        IERC3643Token t = IERC3643Token(address(token));
        address tl = address(timelock);
        issuance = new IssuanceGuard(tl, t, issuanceSafe);
        pauseGuard = new PauseGuard(tl, t, pauser, opsSafe, adminSafe);
        freezeGuard = new FreezeGuard(tl, t, opsSafe);
        recovery = new RecoveryGuard(tl, t, trusteeSafe, adminSafe);
        registrarGuard = new RegistrarGuard(tl, IERC3643IdentityRegistry(address(ir)), registrar, MAX_PER_HOUR);
        distributions = new DistributionRegistry(tl, opsSafe, trusteeSafe);
        documents = new DocumentRegistry(tl, opsSafe);

        token.addAgent(address(issuance));
        token.addAgent(address(pauseGuard));
        token.addAgent(address(freezeGuard));
        token.addAgent(address(recovery));
        ir.addAgent(address(registrarGuard));
        // Identity updates and deletions (e.g. AML offboarding) go through the 72h timelock.
        ir.addAgent(address(timelock));
    }

    /// Post-deploy hand-over: every owner becomes the timelock; the deployer keeps nothing.
    function _handOver() private {
        address tl = address(timelock);
        token.transferOwnership(tl);
        ir.transferOwnership(tl);
        IOwnableV4(ir.issuersRegistry()).transferOwnership(tl);
        IOwnableV4(ir.topicsRegistry()).transferOwnership(tl);
        IOwnableV4(token.compliance()).transferOwnership(tl);
        factory.recoverContractOwnership(ir.identityStorage(), tl);
        factory.transferOwnership(tl);
        // Identity creation is a routine operation; a dedicated operator key owns the ID factory.
        // An identity without claims from the HSM-held issuer cannot hold tokens.
        idFactory.transferOwnership(identityOperator);
    }

    // ---------------------------------------------------------------- helpers

    function _timelockExec(address target, bytes memory data) internal {
        bytes32 salt = bytes32(++_opNonce);
        vm.prank(adminSafe);
        timelock.schedule(target, 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(block.timestamp + TIMELOCK_DELAY);
        vm.prank(adminSafe);
        timelock.execute(target, 0, data, bytes32(0), salt);
    }

    function _claimSignature(address identity, uint256 topic, bytes memory data) internal view returns (bytes memory) {
        bytes32 dataHash = keccak256(abi.encode(identity, topic, data));
        bytes32 prefixed = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", dataHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(claimSignerKey, prefixed);
        return abi.encodePacked(r, s, v);
    }

    /// Creates an ONCHAINID for `wallet` and adds KYC + AML claims signed by the trusted issuer.
    function _createVerifiedIdentity(address wallet) internal returns (address identity) {
        vm.prank(identityOperator);
        identity = idFactory.createIdentity(wallet, vm.toString(++_saltNonce));
        identityOf[wallet] = identity;
        _addClaim(wallet, identity, TOPIC_KYC);
        _addClaim(wallet, identity, TOPIC_AML);
    }

    function _addClaim(address wallet, address identity, uint256 topic) internal returns (bytes memory sig) {
        bytes memory data = abi.encode("verified", topic);
        sig = _claimSignature(identity, topic, data);
        vm.prank(wallet);
        IIdentity(identity).addClaim(topic, 1, address(claimIssuer), sig, data, "");
    }

    /// Full onboarding: identity + claims + registration through the RegistrarGuard.
    function _onboard(address wallet) internal returns (address identity) {
        identity = _createVerifiedIdentity(wallet);
        vm.prank(registrar);
        registrarGuard.register(wallet, identity, PAKISTAN);
    }

    function _mint(address to, uint256 amount) internal {
        vm.prank(issuanceSafe);
        issuance.mint(to, amount, keccak256(abi.encode("ref", to, amount, ++_opNonce)));
    }
}
