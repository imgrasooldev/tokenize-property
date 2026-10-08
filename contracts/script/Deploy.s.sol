// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {DeployLib} from "./DeployLib.sol";

/// @notice Deploys one property token with all guards and hands every power to the timelock.
///         Runs contract-spec.md section 9 steps 1-5 and fails if any post-deploy check fails.
///
/// Usage (local Anvil):
///   cp script/deploy.env.example .env.local   # fill in, never commit
///   source .env.local
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast --account deployer
///
/// The deployer key should come from an encrypted keystore (`cast wallet import deployer ...`) or a
/// hardware wallet (`--ledger`), never from a plain-text private key. Destroy it after deployment.
contract Deploy is Script {
    function run() external returns (DeployLib.Deployment memory d) {
        DeployLib.Config memory c = _config();

        vm.startBroadcast(c.deployer);
        d = DeployLib.deploy(c);
        vm.stopBroadcast();

        DeployLib.checkHandover(c, d);
        _log(d);
    }

    function _config() internal view returns (DeployLib.Config memory c) {
        c.deployer = vm.envAddress("DEPLOYER");
        c.adminSafe = vm.envAddress("ADMIN_SAFE");
        c.trusteeSafe = vm.envAddress("TRUSTEE_SAFE");
        c.issuanceSafe = vm.envAddress("ISSUANCE_SAFE");
        c.opsSafe = vm.envAddress("OPS_SAFE");
        c.pauser = vm.envAddress("PAUSER");
        c.registrar = vm.envAddress("REGISTRAR");
        c.identityOperator = vm.envAddress("IDENTITY_OPERATOR");
        c.claimIssuerManager = vm.envAddress("CLAIM_ISSUER_MANAGER");
        c.claimSigner = vm.envAddress("CLAIM_SIGNER");
        c.timelockDelay = vm.envOr("TIMELOCK_DELAY", uint256(72 hours));
        c.registrarMaxPerHour = vm.envOr("REGISTRAR_MAX_PER_HOUR", uint256(50));
        c.maxBalance = vm.envUint("MAX_BALANCE");
        uint256[] memory countries = vm.envUint("ALLOWED_COUNTRIES", ",");
        c.allowedCountries = new uint16[](countries.length);
        for (uint256 i; i < countries.length; ++i) {
            require(countries[i] <= type(uint16).max, "country code out of range");
            // Safe cast: bounded by the check above.
            // forge-lint: disable-next-line(unsafe-typecast)
            c.allowedCountries[i] = uint16(countries[i]);
        }
        c.salt = vm.envString("TOKEN_SALT");
        c.name = vm.envString("TOKEN_NAME");
        c.symbol = vm.envString("TOKEN_SYMBOL");
    }

    function _log(DeployLib.Deployment memory d) internal pure {
        console2.log("Token                ", address(d.token));
        console2.log("Identity registry    ", address(d.ir));
        console2.log("Timelock             ", address(d.timelock));
        console2.log("IssuanceGuard        ", address(d.issuance));
        console2.log("PauseGuard           ", address(d.pauseGuard));
        console2.log("FreezeGuard          ", address(d.freezeGuard));
        console2.log("RecoveryGuard        ", address(d.recovery));
        console2.log("RegistrarGuard       ", address(d.registrarGuard));
        console2.log("DistributionRegistry ", address(d.distributions));
        console2.log("DocumentRegistry     ", address(d.documents));
        console2.log("ClaimIssuer          ", address(d.claimIssuer));
        console2.log("ID factory           ", address(d.idFactory));
        console2.log("Next: after 72h, timelock setTrusteeCap; then Admin Safe unpauses (go-live).");
    }
}
