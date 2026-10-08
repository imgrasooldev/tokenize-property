// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Governed} from "../common/Governed.sol";
import {IERC3643Token} from "../interfaces/IERC3643.sol";

/// @title IssuanceGuard
/// @notice The only path to mint and burn. Enforces the trustee-register supply cap and one-time
///         reference IDs. Spec: docs/contract-spec.md section 5.1.
/// @dev Must be an agent of `token`. `issuer` is the Issuance Safe (2-of-3 including a trustee signer).
contract IssuanceGuard is Governed {
    IERC3643Token public immutable token;

    address public issuer;
    /// @notice Units recorded on the trustee's register. totalSupply can never exceed it.
    uint256 public trusteeCap;
    /// @notice Off-chain subscription or redemption references already used.
    mapping(bytes32 refId => bool used) public refUsed;

    event IssuerSet(address indexed previous, address indexed current);
    event TrusteeCapSet(uint256 previous, uint256 current);
    event Minted(address indexed to, uint256 amount, bytes32 indexed refId);
    event Burned(address indexed from, uint256 amount, bytes32 indexed refId);

    error CapBelowSupply(uint256 cap, uint256 supply);
    error CapExceeded(uint256 newSupply, uint256 cap);
    error InvalidRef();
    error RefAlreadyUsed(bytes32 refId);
    error ZeroAmount();
    error TokenPaused();

    modifier onlyIssuer() {
        if (msg.sender != issuer) revert Unauthorized(msg.sender);
        _;
    }

    constructor(address timelock, IERC3643Token token_, address issuer_) Governed(timelock) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (issuer_ == address(0)) revert ZeroAddress();
        token = token_;
        issuer = issuer_;
        emit IssuerSet(address(0), issuer_);
    }

    /// @notice Rotates the Issuance Safe.
    /// @dev Timelock only. Reverts on the zero address.
    function setIssuer(address issuer_) external onlyOwner {
        if (issuer_ == address(0)) revert ZeroAddress();
        emit IssuerSet(issuer, issuer_);
        issuer = issuer_;
    }

    /// @notice Sets the number of units on the trustee's register.
    /// @dev Timelock only. Cannot be set below the current total supply.
    /// @param cap New maximum total supply.
    function setTrusteeCap(uint256 cap) external onlyOwner {
        uint256 supply = token.totalSupply();
        if (cap < supply) revert CapBelowSupply(cap, supply);
        emit TrusteeCapSet(trusteeCap, cap);
        trusteeCap = cap;
    }

    /// @notice Mint is refused while the token is paused (ERC-3643 itself would allow it).
    /// @param to Verified investor wallet receiving the tokens.
    /// @param amount Token units to mint; must be non-zero.
    /// @param refId Off-chain subscription reference; usable once.
    function mint(address to, uint256 amount, bytes32 refId) external onlyIssuer {
        if (token.paused()) revert TokenPaused();
        _useRef(refId, amount);
        uint256 newSupply = token.totalSupply() + amount;
        if (newSupply > trusteeCap) revert CapExceeded(newSupply, trusteeCap);
        emit Minted(to, amount, refId);
        token.mint(to, amount);
    }

    /// @notice Burns tokens for a redemption or exit.
    /// @dev Issuance Safe only. Unfreezes frozen tokens if needed (ERC-3643 behaviour).
    /// @param from Investor wallet.
    /// @param amount Token units to burn; must be non-zero.
    /// @param refId Off-chain redemption reference; usable once.
    function burn(address from, uint256 amount, bytes32 refId) external onlyIssuer {
        _useRef(refId, amount);
        emit Burned(from, amount, refId);
        token.burn(from, amount);
    }

    function _useRef(bytes32 refId, uint256 amount) private {
        if (amount == 0) revert ZeroAmount();
        if (refId == bytes32(0)) revert InvalidRef();
        if (refUsed[refId]) revert RefAlreadyUsed(refId);
        refUsed[refId] = true;
    }
}
