// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {IERC3643Token, IERC3643IdentityRegistry} from "../src/interfaces/IERC3643.sol";
import {IssuanceGuard} from "../src/guards/IssuanceGuard.sol";
import {PauseGuard} from "../src/guards/PauseGuard.sol";
import {FreezeGuard} from "../src/guards/FreezeGuard.sol";
import {RecoveryGuard} from "../src/guards/RecoveryGuard.sol";
import {RegistrarGuard} from "../src/guards/RegistrarGuard.sol";
import {DistributionRegistry} from "../src/registries/DistributionRegistry.sol";
import {DocumentRegistry} from "../src/registries/DocumentRegistry.sol";

import {
    ITokenFull,
    IIdentityRegistryFull,
    ITREXImplementationAuthority,
    ITREXFactory,
    IIdFactory,
    IClaimIssuer,
    IOwnableV4,
    IModularCompliance,
    ICountryAllowModule,
    IMaxBalanceModule
} from "./VendorInterfaces.sol";

/// @title DeployLib
/// @notice The one deployment procedure (contract-spec.md section 9), shared by the production
///         script and the test fixture so that what is tested is exactly what is deployed.
/// @dev Steps 1-5 of the spec. Step 6 (bytecode verification) and step 7 (destroy deployer key) are
///      operational. Step 8 (go-live) needs two timelock operations after 72h: set the trustee cap,
///      then the Admin Safe unpauses.
library DeployLib {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant MIN_TIMELOCK_DELAY = 72 hours;
    uint256 internal constant TOPIC_KYC = 1;
    uint256 internal constant TOPIC_AML = 2;

    struct Config {
        /// Address sending the deployment transactions. Holds temporary powers only.
        address deployer;
        address adminSafe;
        address trusteeSafe;
        address issuanceSafe;
        address opsSafe;
        address pauser;
        address registrar;
        address identityOperator;
        /// Management key of the ClaimIssuer (Admin Safe in production).
        address claimIssuerManager;
        /// HSM-held key that signs KYC and AML claims.
        address claimSigner;
        uint256 timelockDelay;
        uint256 registrarMaxPerHour;
        /// Per-investor (per ONCHAINID) holding cap in token units.
        uint256 maxBalance;
        uint16[] allowedCountries;
        string salt;
        string name;
        string symbol;
    }

    struct Deployment {
        TimelockController timelock;
        address oidAuthority;
        address trexAuthority;
        IIdFactory idFactory;
        ITREXFactory factory;
        IClaimIssuer claimIssuer;
        ICountryAllowModule countryModule;
        IMaxBalanceModule maxBalanceModule;
        ITokenFull token;
        IIdentityRegistryFull ir;
        IssuanceGuard issuance;
        PauseGuard pauseGuard;
        FreezeGuard freezeGuard;
        RecoveryGuard recovery;
        RegistrarGuard registrarGuard;
        DistributionRegistry distributions;
        DocumentRegistry documents;
    }

    function deploy(Config memory c) internal returns (Deployment memory d) {
        require(c.timelockDelay >= MIN_TIMELOCK_DELAY, "DeployLib: timelock delay below 72h");
        require(c.maxBalance > 0 && c.allowedCountries.length > 0, "DeployLib: compliance config");

        d.timelock = _deployTimelock(c);
        _deployIdentityInfra(c, d);
        _deployModules(d);
        _deployTokenSuite(c, d);
        _deployGuards(c, d);
        _handOver(c, d);
    }

    // ------------------------------------------------------------------ steps

    function _deployTimelock(Config memory c) private returns (TimelockController timelock) {
        address[] memory proposers = new address[](1);
        proposers[0] = c.adminSafe;
        address[] memory executors = new address[](1);
        executors[0] = c.adminSafe;
        timelock = new TimelockController(c.timelockDelay, proposers, executors, c.deployer);
        timelock.grantRole(timelock.CANCELLER_ROLE(), c.trusteeSafe);
        timelock.renounceRole(timelock.DEFAULT_ADMIN_ROLE(), c.deployer);
    }

    function _deployIdentityInfra(Config memory c, Deployment memory d) private {
        address identityImpl = _create("Identity.sol:Identity", abi.encode(c.deployer, true));
        d.oidAuthority = _create("ImplementationAuthority.sol:ImplementationAuthority", abi.encode(identityImpl));
        d.idFactory = IIdFactory(_create("IdFactory.sol:IdFactory", abi.encode(d.oidAuthority)));

        // Claim issuer: add the HSM signing key, hand management to the manager, drop the deployer.
        d.claimIssuer = IClaimIssuer(_create("ClaimIssuer.sol:ClaimIssuer", abi.encode(c.deployer)));
        d.claimIssuer.addKey(keccak256(abi.encode(c.claimSigner)), 3, 1);
        d.claimIssuer.addKey(keccak256(abi.encode(c.claimIssuerManager)), 1, 1);
        d.claimIssuer.removeKey(keccak256(abi.encode(c.deployer)), 1);
    }

    function _deployModules(Deployment memory d) private {
        bytes memory init = abi.encodeWithSignature("initialize()");
        d.countryModule = ICountryAllowModule(
            _create(
                "ModuleProxy.sol:ModuleProxy",
                abi.encode(_create("CountryAllowModule.sol:CountryAllowModule", ""), init)
            )
        );
        d.maxBalanceModule = IMaxBalanceModule(
            _create(
                "ModuleProxy.sol:ModuleProxy", abi.encode(_create("MaxBalanceModule.sol:MaxBalanceModule", ""), init)
            )
        );
    }

    function _deployTokenSuite(Config memory c, Deployment memory d) private {
        ITREXImplementationAuthority.TREXContracts memory impls = ITREXImplementationAuthority.TREXContracts({
            tokenImplementation: _create("Token.sol:Token", ""),
            ctrImplementation: _create("ClaimTopicsRegistry.sol:ClaimTopicsRegistry", ""),
            irImplementation: _create("IdentityRegistry.sol:IdentityRegistry", ""),
            irsImplementation: _create("IdentityRegistryStorage.sol:IdentityRegistryStorage", ""),
            tirImplementation: _create("TrustedIssuersRegistry.sol:TrustedIssuersRegistry", ""),
            mcImplementation: _create("ModularCompliance.sol:ModularCompliance", "")
        });
        d.trexAuthority = _create(
            "TREXImplementationAuthority.sol:TREXImplementationAuthority", abi.encode(true, address(0), address(0))
        );
        ITREXImplementationAuthority(d.trexAuthority)
            .addAndUseTREXVersion(ITREXImplementationAuthority.Version(4, 1, 3), impls);
        d.factory =
            ITREXFactory(_create("TREXFactory.sol:TREXFactory", abi.encode(d.trexAuthority, address(d.idFactory))));
        d.idFactory.addTokenFactory(address(d.factory));

        uint256[] memory topics = new uint256[](2);
        topics[0] = TOPIC_KYC;
        topics[1] = TOPIC_AML;
        address[] memory issuers = new address[](1);
        issuers[0] = address(d.claimIssuer);
        uint256[][] memory issuerClaims = new uint256[][](1);
        issuerClaims[0] = topics;

        address[] memory modules = new address[](2);
        modules[0] = address(d.countryModule);
        modules[1] = address(d.maxBalanceModule);
        bytes[] memory settings = new bytes[](2);
        settings[0] = abi.encodeCall(ICountryAllowModule.batchAllowCountries, (c.allowedCountries));
        settings[1] = abi.encodeCall(IMaxBalanceModule.setMaxBalance, (c.maxBalance));

        d.factory
            .deployTREXSuite(
                c.salt,
                ITREXFactory.TokenDetails({
                    owner: c.deployer,
                    name: c.name,
                    symbol: c.symbol,
                    decimals: 0,
                    irs: address(0),
                    ONCHAINID: address(0),
                    irAgents: new address[](0),
                    tokenAgents: new address[](0),
                    complianceModules: modules,
                    complianceSettings: settings
                }),
                ITREXFactory.ClaimDetails({claimTopics: topics, issuers: issuers, issuerClaims: issuerClaims})
            );
        d.token = ITokenFull(d.factory.getToken(c.salt));
        d.ir = IIdentityRegistryFull(d.token.identityRegistry());
    }

    function _deployGuards(Config memory c, Deployment memory d) private {
        address tl = address(d.timelock);
        IERC3643Token t = IERC3643Token(address(d.token));
        d.issuance = new IssuanceGuard(tl, t, c.issuanceSafe);
        d.pauseGuard = new PauseGuard(tl, t, c.pauser, c.opsSafe, c.adminSafe);
        d.freezeGuard = new FreezeGuard(tl, t, c.opsSafe);
        d.recovery = new RecoveryGuard(tl, t, c.trusteeSafe, c.adminSafe);
        d.registrarGuard =
            new RegistrarGuard(tl, IERC3643IdentityRegistry(address(d.ir)), c.registrar, c.registrarMaxPerHour);
        d.distributions = new DistributionRegistry(tl, c.opsSafe, c.trusteeSafe);
        d.documents = new DocumentRegistry(tl, c.opsSafe);

        d.token.addAgent(address(d.issuance));
        d.token.addAgent(address(d.pauseGuard));
        d.token.addAgent(address(d.freezeGuard));
        d.token.addAgent(address(d.recovery));
        d.ir.addAgent(address(d.registrarGuard));
        // Identity updates and deletions (e.g. AML offboarding) go through the 72h timelock.
        d.ir.addAgent(tl);
    }

    /// Every owner becomes the timelock; the deployer keeps nothing.
    function _handOver(Config memory c, Deployment memory d) private {
        address tl = address(d.timelock);
        d.token.transferOwnership(tl);
        d.ir.transferOwnership(tl);
        IOwnableV4(d.ir.issuersRegistry()).transferOwnership(tl);
        IOwnableV4(d.ir.topicsRegistry()).transferOwnership(tl);
        IOwnableV4(d.token.compliance()).transferOwnership(tl);
        d.factory.recoverContractOwnership(d.ir.identityStorage(), tl);
        d.factory.transferOwnership(tl);
        // Upgrade authorities: whoever owns these can replace the code of every token / every identity.
        IOwnableV4(d.trexAuthority).transferOwnership(tl);
        IOwnableV4(d.oidAuthority).transferOwnership(tl);
        // UUPS modules: the owner can upgrade the module code.
        d.countryModule.transferOwnership(tl);
        d.maxBalanceModule.transferOwnership(tl);
        // Identity creation is routine; a dedicated operator key owns the ID factory. An identity without
        // claims from the HSM-held issuer cannot hold tokens.
        d.idFactory.transferOwnership(c.identityOperator);
    }

    // ------------------------------------------------------------------ post-deploy check

    /// @notice Asserts invariants I-8 and I-9 on a live deployment. Reverts with the first failure.
    function checkHandover(Config memory c, Deployment memory d) internal view {
        address tl = address(d.timelock);
        require(d.timelock.getMinDelay() >= MIN_TIMELOCK_DELAY, "I-9: timelock delay");
        require(!d.timelock.hasRole(d.timelock.DEFAULT_ADMIN_ROLE(), c.deployer), "I-9: deployer timelock admin");
        require(!d.timelock.hasRole(d.timelock.PROPOSER_ROLE(), c.deployer), "I-9: deployer proposer");
        require(d.timelock.hasRole(d.timelock.CANCELLER_ROLE(), c.trusteeSafe), "I-9: trustee canceller");

        address[13] memory owned = [
            address(d.token),
            address(d.ir),
            d.ir.identityStorage(),
            d.ir.issuersRegistry(),
            d.ir.topicsRegistry(),
            d.token.compliance(),
            address(d.factory),
            d.trexAuthority,
            d.oidAuthority,
            address(d.countryModule),
            address(d.maxBalanceModule),
            address(d.issuance),
            address(d.pauseGuard)
        ];
        for (uint256 i; i < owned.length; ++i) {
            require(IOwnableV4(owned[i]).owner() == tl, "I-9: owner is not the timelock");
        }
        address[5] memory ownedToo = [
            address(d.freezeGuard),
            address(d.recovery),
            address(d.registrarGuard),
            address(d.distributions),
            address(d.documents)
        ];
        for (uint256 i; i < ownedToo.length; ++i) {
            require(IOwnableV4(ownedToo[i]).owner() == tl, "I-9: owner is not the timelock");
        }
        require(d.idFactory.owner() == c.identityOperator, "I-9: ID factory owner");

        require(d.token.isAgent(address(d.issuance)), "I-8: issuance agent");
        require(d.token.isAgent(address(d.pauseGuard)), "I-8: pause agent");
        require(d.token.isAgent(address(d.freezeGuard)), "I-8: freeze agent");
        require(d.token.isAgent(address(d.recovery)), "I-8: recovery agent");
        require(!d.token.isAgent(c.deployer) && !d.ir.isAgent(c.deployer), "I-8: deployer is agent");
        require(!d.token.isAgent(tl), "I-8: timelock is token agent");
        require(d.ir.isAgent(address(d.registrarGuard)) && d.ir.isAgent(tl), "I-8: registry agents");

        require(!d.claimIssuer.keyHasPurpose(keccak256(abi.encode(c.deployer)), 1), "deployer manages claim issuer");
        require(d.claimIssuer.keyHasPurpose(keccak256(abi.encode(c.claimSigner)), 3), "claim signer missing");

        IModularCompliance mc = IModularCompliance(d.token.compliance());
        require(mc.isModuleBound(address(d.countryModule)), "country module not bound");
        require(mc.isModuleBound(address(d.maxBalanceModule)), "max balance module not bound");
        require(d.token.paused(), "token must stay paused until go-live");
    }

    // ------------------------------------------------------------------ helpers

    function _create(string memory artifact, bytes memory args) private returns (address addr) {
        bytes memory code = bytes.concat(vm.getCode(artifact), args);
        assembly ("memory-safe") {
            addr := create(0, add(code, 0x20), mload(code))
        }
        require(addr != address(0), string.concat("DeployLib: create failed for ", artifact));
    }
}
