// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Governed} from "../common/Governed.sol";
import {IERC3643IdentityRegistry} from "../interfaces/IERC3643.sol";

/// @title RegistrarGuard
/// @notice Registers KYC-approved investors in the identity registry, under an exact rolling
///         one-hour rate limit. Registration only succeeds if the identity already carries valid
///         claims from the trusted issuer. Spec: docs/contract-spec.md section 5.5.
/// @dev The only agent of the identity registry besides the token. It can register, never update
///      or delete. `maxPerHour` is immutable: changing it means deploying a new guard through the
///      timelock, which keeps the sliding window exact.
contract RegistrarGuard is Governed {
    uint256 public constant WINDOW = 1 hours;
    uint256 public constant MAX_PER_HOUR_LIMIT = 500;

    IERC3643IdentityRegistry public immutable identityRegistry;
    uint256 public immutable maxPerHour;

    address public registrar;

    /// Ring buffer of the last `maxPerHour` registration timestamps.
    mapping(uint256 slot => uint256 timestamp) private _ring;
    uint256 private _head;

    event RegistrarSet(address indexed previous, address indexed current);
    event InvestorRegistered(address indexed account, address indexed identity, uint16 country);

    error InvalidLimit();
    error RateLimited(uint256 retryAfter);
    error NotVerified(address account);

    constructor(address timelock, IERC3643IdentityRegistry identityRegistry_, address registrar_, uint256 maxPerHour_)
        Governed(timelock)
    {
        if (address(identityRegistry_) == address(0)) revert ZeroAddress();
        if (registrar_ == address(0)) revert ZeroAddress();
        if (maxPerHour_ == 0 || maxPerHour_ > MAX_PER_HOUR_LIMIT) revert InvalidLimit();
        identityRegistry = identityRegistry_;
        registrar = registrar_;
        maxPerHour = maxPerHour_;
        emit RegistrarSet(address(0), registrar_);
    }

    /// @notice Rotates the registrar hot key.
    /// @dev Timelock only. Reverts on the zero address.
    function setRegistrar(address registrar_) external onlyOwner {
        if (registrar_ == address(0)) revert ZeroAddress();
        emit RegistrarSet(registrar, registrar_);
        registrar = registrar_;
    }

    /// @notice Registers a KYC-approved investor wallet.
    /// @dev Registrar only. Rate-limited; reverts unless the identity already holds valid claims.
    /// @param account Investor wallet.
    /// @param identity Investor ONCHAINID.
    /// @param country ISO 3166 numeric country code.
    function register(address account, address identity, uint16 country) external {
        if (msg.sender != registrar) revert Unauthorized(msg.sender);
        if (account == address(0)) revert ZeroAddress();
        if (identity == address(0)) revert ZeroAddress();

        // The oldest of the last `maxPerHour` registrations must be at least WINDOW old.
        uint256 oldest = _ring[_head];
        // Timestamp use is intentional: delays are hours long and QBFT validators can skew time by seconds only.
        // slither-disable-start timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (oldest != 0 && block.timestamp < oldest + WINDOW) revert RateLimited(oldest + WINDOW);
        // slither-disable-end timestamp
        _ring[_head] = block.timestamp;
        _head = (_head + 1) % maxPerHour;

        emit InvestorRegistered(account, identity, country);
        identityRegistry.registerIdentity(account, identity, country);
        if (!identityRegistry.isVerified(account)) revert NotVerified(account);
    }

    /// @notice Registrations accepted in the last WINDOW seconds.
    function recentRegistrations() external view returns (uint256 count) {
        for (uint256 i; i < maxPerHour; ++i) {
            uint256 t = _ring[i];
            // Timestamp use is intentional: delays are hours long and QBFT validators can skew time by seconds only.
            // slither-disable-start timestamp
            // forge-lint: disable-next-line(block-timestamp)
            if (t != 0 && block.timestamp < t + WINDOW) ++count;
            // slither-disable-end timestamp
        }
    }
}
