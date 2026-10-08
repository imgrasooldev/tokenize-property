// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

// Compliance modules from T-REX 4.1.6 (lib/trex), unchanged. Kept in a separate file because T-REX ships
// its own identical copies of the ERC-3643 interfaces, which would clash with ERC3643Suite.sol.
// These modules post-date the April 2023 Hacken audit, so they are in our own external-audit scope.

import "@trex/contracts/compliance/modular/modules/CountryAllowModule.sol";
import "@trex/contracts/compliance/modular/modules/MaxBalanceModule.sol";
import "@trex/contracts/compliance/modular/modules/ModuleProxy.sol";
