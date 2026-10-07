// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.17;

// ABI-compatible views of the vendored ERC-3643 4.1.3 / ONCHAINID 2.2.1 contracts, so tests compiled
// with solc 0.8.30 can drive contracts compiled with 0.8.17 (deployed from artifacts via deployCode).

interface IOwnableV4 {
    function owner() external view returns (address);
    function transferOwnership(address newOwner) external;
}

interface IAgentRole {
    function addAgent(address agent) external;
    function removeAgent(address agent) external;
    function isAgent(address agent) external view returns (bool);
}

interface ITokenFull is IOwnableV4, IAgentRole {
    function name() external view returns (string memory);
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function paused() external view returns (bool);
    function isFrozen(address account) external view returns (bool);
    function getFrozenTokens(address account) external view returns (uint256);
    function identityRegistry() external view returns (address);
    function compliance() external view returns (address);
    function transfer(address to, uint256 amount) external returns (bool);
    function mint(address to, uint256 amount) external;
    function pause() external;
}

interface IIdentityRegistryFull is IOwnableV4, IAgentRole {
    function registerIdentity(address account, address identity, uint16 country) external;
    function deleteIdentity(address account) external;
    function contains(address account) external view returns (bool);
    function isVerified(address account) external view returns (bool);
    function identity(address account) external view returns (address);
    function identityStorage() external view returns (address);
    function issuersRegistry() external view returns (address);
    function topicsRegistry() external view returns (address);
}

interface ITREXImplementationAuthority {
    struct TREXContracts {
        address tokenImplementation;
        address ctrImplementation;
        address irImplementation;
        address irsImplementation;
        address tirImplementation;
        address mcImplementation;
    }

    struct Version {
        uint8 major;
        uint8 minor;
        uint8 patch;
    }

    function addAndUseTREXVersion(Version calldata version, TREXContracts calldata trex) external;
}

interface ITREXFactory is IOwnableV4 {
    struct TokenDetails {
        address owner;
        string name;
        string symbol;
        uint8 decimals;
        address irs;
        address ONCHAINID;
        address[] irAgents;
        address[] tokenAgents;
        address[] complianceModules;
        bytes[] complianceSettings;
    }

    struct ClaimDetails {
        uint256[] claimTopics;
        address[] issuers;
        uint256[][] issuerClaims;
    }

    function deployTREXSuite(string memory salt, TokenDetails calldata tokenDetails, ClaimDetails calldata claimDetails)
        external;
    function getToken(string calldata salt) external view returns (address);
    function recoverContractOwnership(address target, address newOwner) external;
}

interface IIdFactory is IOwnableV4 {
    function addTokenFactory(address factory) external;
    function createIdentity(address wallet, string memory salt) external returns (address);
}

interface IIdentity {
    function addKey(bytes32 key, uint256 purpose, uint256 keyType) external returns (bool);
    function keyHasPurpose(bytes32 key, uint256 purpose) external view returns (bool);
    function addClaim(
        uint256 topic,
        uint256 scheme,
        address issuer,
        bytes calldata signature,
        bytes calldata data,
        string calldata uri
    ) external returns (bytes32);
}

interface IClaimIssuer is IIdentity {
    function revokeClaimBySignature(bytes calldata signature) external;
    function isClaimRevoked(bytes calldata signature) external view returns (bool);
    function isClaimValid(address identity, uint256 topic, bytes calldata sig, bytes calldata data)
        external
        view
        returns (bool);
}
