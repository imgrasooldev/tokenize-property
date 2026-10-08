// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Governed} from "../common/Governed.sol";
import {IERC3643Token} from "../interfaces/IERC3643.sol";

/// @title RecoveryGuard
/// @notice Wallet recovery and forced transfers (court orders, succession), with a mandatory delay
///         during which the Admin Safe or the Trustee Safe can cancel. Spec: docs/contract-spec.md
///         section 5.4.
/// @dev Both actions work while the token is paused, so the trustee can act during an incident.
contract RecoveryGuard is Governed {
    enum Kind {
        WalletRecovery,
        ForcedTransfer
    }

    enum Status {
        None,
        Pending,
        Executed,
        Cancelled
    }

    struct Request {
        Kind kind;
        Status status;
        uint64 eta;
        address from;
        address to;
        /// Investor ONCHAINID, used only for WalletRecovery.
        address onchainId;
        /// Token amount, used only for ForcedTransfer (recovery always moves the full balance).
        uint256 amount;
        /// Hash of the court order or re-verification file recorded in the DocumentRegistry.
        bytes32 evidenceHash;
    }

    uint256 public constant RECOVERY_DELAY = 48 hours;

    IERC3643Token public immutable token;

    address public trusteeSafe;
    address public adminSafe;

    uint256 public requestCount;
    mapping(uint256 id => Request) internal _requests;

    event TrusteeSafeSet(address indexed previous, address indexed current);
    event AdminSafeSet(address indexed previous, address indexed current);
    event RecoveryProposed(
        uint256 indexed id,
        Kind kind,
        address indexed from,
        address indexed to,
        address onchainId,
        uint256 amount,
        bytes32 evidenceHash,
        uint64 eta
    );
    event RecoveryExecuted(uint256 indexed id);
    event RecoveryCancelled(uint256 indexed id, address indexed by);

    error InvalidRequest();
    error NotPending(uint256 id);
    error TooEarly(uint256 id, uint64 eta);
    error ExecutionFailed(uint256 id);

    modifier onlyTrustee() {
        if (msg.sender != trusteeSafe) revert Unauthorized(msg.sender);
        _;
    }

    constructor(address timelock, IERC3643Token token_, address trusteeSafe_, address adminSafe_) Governed(timelock) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (trusteeSafe_ == address(0)) revert ZeroAddress();
        if (adminSafe_ == address(0)) revert ZeroAddress();
        token = token_;
        trusteeSafe = trusteeSafe_;
        adminSafe = adminSafe_;
        emit TrusteeSafeSet(address(0), trusteeSafe_);
        emit AdminSafeSet(address(0), adminSafe_);
    }

    /// @notice Rotates the Trustee Safe.
    /// @dev Timelock only. Reverts on the zero address.
    function setTrusteeSafe(address trusteeSafe_) external onlyOwner {
        if (trusteeSafe_ == address(0)) revert ZeroAddress();
        emit TrusteeSafeSet(trusteeSafe, trusteeSafe_);
        trusteeSafe = trusteeSafe_;
    }

    /// @notice Rotates the Admin Safe.
    /// @dev Timelock only. Reverts on the zero address.
    function setAdminSafe(address adminSafe_) external onlyOwner {
        if (adminSafe_ == address(0)) revert ZeroAddress();
        emit AdminSafeSet(adminSafe, adminSafe_);
        adminSafe = adminSafe_;
    }

    /// @notice Starts a recovery or forced transfer; executable after RECOVERY_DELAY.
    /// @dev Trustee Safe only.
    /// @param kind WalletRecovery (full balance to a new wallet of the same ONCHAINID) or ForcedTransfer.
    /// @param from Wallet the tokens move from.
    /// @param to Wallet the tokens move to.
    /// @param onchainId Investor ONCHAINID; required for WalletRecovery, zero for ForcedTransfer.
    /// @param amount Token units; zero for WalletRecovery, non-zero for ForcedTransfer.
    /// @param evidenceHash Hash of the court order or re-verification file; must be non-zero.
    /// @return id Request ID.
    function propose(Kind kind, address from, address to, address onchainId, uint256 amount, bytes32 evidenceHash)
        external
        onlyTrustee
        returns (uint256 id)
    {
        if (from == address(0) || to == address(0) || from == to || evidenceHash == bytes32(0)) {
            revert InvalidRequest();
        }
        if (kind == Kind.WalletRecovery) {
            if (onchainId == address(0) || amount != 0) revert InvalidRequest();
        } else {
            if (onchainId != address(0) || amount == 0) revert InvalidRequest();
        }

        id = ++requestCount;
        // Safe cast: uint64 seconds overflow in year 584 billion.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint64 eta = uint64(block.timestamp + RECOVERY_DELAY);
        _requests[id] = Request({
            kind: kind,
            status: Status.Pending,
            eta: eta,
            from: from,
            to: to,
            onchainId: onchainId,
            amount: amount,
            evidenceHash: evidenceHash
        });
        emit RecoveryProposed(id, kind, from, to, onchainId, amount, evidenceHash, eta);
    }

    /// @notice Executes a pending request once its delay has passed.
    /// @dev Trustee Safe only. Works while the token is paused.
    /// @param id Request ID.
    function execute(uint256 id) external onlyTrustee {
        Request storage r = _requests[id];
        if (r.status != Status.Pending) revert NotPending(id);
        // Timestamp use is intentional: delays are hours long and QBFT validators can skew time by seconds only.
        // slither-disable-start timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < r.eta) revert TooEarly(id, r.eta);
        // slither-disable-end timestamp

        // Effects before interactions: a request can never execute twice.
        r.status = Status.Executed;
        emit RecoveryExecuted(id);

        bool ok = r.kind == Kind.WalletRecovery
            ? token.recoveryAddress(r.from, r.to, r.onchainId)
            : token.forcedTransfer(r.from, r.to, r.amount);
        if (!ok) revert ExecutionFailed(id);
    }

    /// @notice Cancels a pending request.
    /// @dev Trustee Safe or Admin Safe.
    /// @param id Request ID.
    function cancel(uint256 id) external {
        if (msg.sender != trusteeSafe && msg.sender != adminSafe) revert Unauthorized(msg.sender);
        Request storage r = _requests[id];
        if (r.status != Status.Pending) revert NotPending(id);
        r.status = Status.Cancelled;
        emit RecoveryCancelled(id, msg.sender);
    }

    /// @notice Returns a request.
    /// @param id Request ID.
    function getRequest(uint256 id) external view returns (Request memory) {
        return _requests[id];
    }
}
