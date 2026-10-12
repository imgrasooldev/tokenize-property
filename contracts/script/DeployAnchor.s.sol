// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";
import {DeployLib} from "./DeployLib.sol";
import {StateAnchor} from "../src/anchor/StateAnchor.sol";

/// @notice Deploys StateAnchor on the public anchor chain and runs the post-deploy check
///         (contract-spec.md section 7.2).
///
/// Environment: DEPLOYER, ANCHOR_OWNER (the Safe on the public chain), ANCHORER (the anchor key's
/// address). On the local Anvil stand-in (chain ID 586650) also LOCAL_DEV_NETWORK=true; there the
/// owner may be a plain address. `python chain/anchor.py deploy` runs this locally.
///
/// The deployer key should come from an encrypted keystore or a hardware wallet, never from a
/// plain-text private key. It holds no power after deployment.
contract DeployAnchor is Script {
    function run() external returns (StateAnchor anchor) {
        DeployLib.AnchorConfig memory c = DeployLib.AnchorConfig({
            deployer: vm.envAddress("DEPLOYER"),
            owner: vm.envAddress("ANCHOR_OWNER"),
            anchorer: vm.envAddress("ANCHORER")
        });
        // The stand-in chain ID relaxes the "owner is a Safe" check. Require an explicit opt-in as
        // well, so a network misconfigured with that ID cannot get an EOA owner by accident.
        if (block.chainid == DeployLib.LOCAL_ANCHOR_CHAIN_ID) {
            require(
                vm.envOr("LOCAL_DEV_NETWORK", false), "DeployAnchor: stand-in chain ID without LOCAL_DEV_NETWORK=true"
            );
        }

        vm.startBroadcast(c.deployer);
        anchor = DeployLib.deployAnchor(c);
        vm.stopBroadcast();

        DeployLib.checkAnchor(c, anchor);
        console2.log("StateAnchor ", address(anchor));
        console2.log("Owner (Safe)", c.owner);
        console2.log("Anchor key  ", c.anchorer);
    }
}
