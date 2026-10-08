// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

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
    ITREXFactory,
    IIdFactory,
    IIdentity,
    IClaimIssuer,
    ICountryAllowModule,
    IMaxBalanceModule
} from "../../script/VendorInterfaces.sol";
import {DeployLib} from "../../script/DeployLib.sol";

/// @notice Deploys the full system through DeployLib, the same code the production script runs,
///         checks the hand-over, then performs go-live (trustee cap via timelock, Admin Safe unpause).
abstract contract Fixture is Test {
    uint256 internal constant TIMELOCK_DELAY = 72 hours;
    uint256 internal constant TOPIC_KYC = 1;
    uint256 internal constant TOPIC_AML = 2;
    uint16 internal constant PAKISTAN = 586;
    uint256 internal constant INITIAL_CAP = 1_000_000;
    uint256 internal constant MAX_PER_HOUR = 50;
    /// 10% of the cap per investor (contract-spec.md section 4.3).
    uint256 internal constant MAX_BALANCE = INITIAL_CAP / 10;
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
    DeployLib.Config internal config;
    DeployLib.Deployment internal deployment;
    TimelockController internal timelock;
    ITREXFactory internal factory;
    IIdFactory internal idFactory;
    IClaimIssuer internal claimIssuer;
    ICountryAllowModule internal countryModule;
    IMaxBalanceModule internal maxBalanceModule;
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
        uint16[] memory countries = new uint16[](1);
        countries[0] = PAKISTAN;
        config = DeployLib.Config({
            deployer: address(this),
            adminSafe: adminSafe,
            trusteeSafe: trusteeSafe,
            issuanceSafe: issuanceSafe,
            opsSafe: opsSafe,
            pauser: pauser,
            registrar: registrar,
            identityOperator: identityOperator,
            claimIssuerManager: claimIssuerManager,
            claimSigner: claimSigner,
            timelockDelay: TIMELOCK_DELAY,
            registrarMaxPerHour: MAX_PER_HOUR,
            maxBalance: MAX_BALANCE,
            allowedCountries: countries,
            salt: SALT,
            name: "Gulberg Plaza Floor 3",
            symbol: "GPF3"
        });
        deployment = DeployLib.deploy(config);
        DeployLib.checkHandover(config, deployment);
        _expose(deployment);

        // Go-live (spec section 9, step 8): set the trustee cap through the timelock, then unpause.
        _timelockExec(address(issuance), abi.encodeCall(IssuanceGuard.setTrusteeCap, (INITIAL_CAP)));
        vm.prank(adminSafe);
        pauseGuard.unpause();
    }

    function _expose(DeployLib.Deployment memory d) private {
        timelock = d.timelock;
        factory = d.factory;
        idFactory = d.idFactory;
        claimIssuer = d.claimIssuer;
        countryModule = d.countryModule;
        maxBalanceModule = d.maxBalanceModule;
        token = d.token;
        ir = d.ir;
        issuance = d.issuance;
        pauseGuard = d.pauseGuard;
        freezeGuard = d.freezeGuard;
        recovery = d.recovery;
        registrarGuard = d.registrarGuard;
        distributions = d.distributions;
        documents = d.documents;
    }

    // ---------------------------------------------------------------- helpers

    function _timelockExec(address target, bytes memory data) internal {
        bytes32 salt = bytes32(++_opNonce);
        vm.prank(adminSafe);
        timelock.schedule(target, 0, data, bytes32(0), salt, TIMELOCK_DELAY);
        vm.warp(vm.getBlockTimestamp() + TIMELOCK_DELAY);
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
