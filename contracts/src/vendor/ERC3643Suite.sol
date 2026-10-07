// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.17;

// Pulls the audited ERC-3643 4.1.3 and ONCHAINID 2.2.1 contracts into the build, unchanged, so tests
// and deploy scripts can deploy them from artifacts. Nothing in this file is our code.

import "@erc3643/contracts/token/Token.sol";
import "@erc3643/contracts/registry/implementation/ClaimTopicsRegistry.sol";
import "@erc3643/contracts/registry/implementation/IdentityRegistry.sol";
import "@erc3643/contracts/registry/implementation/IdentityRegistryStorage.sol";
import "@erc3643/contracts/registry/implementation/TrustedIssuersRegistry.sol";
import "@erc3643/contracts/compliance/modular/ModularCompliance.sol";
import "@erc3643/contracts/proxy/authority/TREXImplementationAuthority.sol";
import "@erc3643/contracts/factory/TREXFactory.sol";

import "@onchain-id/solidity/contracts/Identity.sol";
import "@onchain-id/solidity/contracts/ClaimIssuer.sol";
import "@onchain-id/solidity/contracts/factory/IdFactory.sol";
import "@onchain-id/solidity/contracts/proxy/ImplementationAuthority.sol";
