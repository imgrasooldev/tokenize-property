// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Governed} from "../common/Governed.sol";

/// @title DistributionRegistry
/// @notice Records rent distributions as Merkle roots of (wallet, amountPaisa) entitlements. No
///         money moves on-chain: PKR is paid by the bank and the payout batch hash is recorded
///         afterwards. Spec: docs/contract-spec.md section 6.1.
/// @dev Leaves follow the OpenZeppelin StandardMerkleTree format:
///      keccak256(bytes.concat(keccak256(abi.encode(account, amountPaisa)))).
contract DistributionRegistry is Governed {
    enum Status {
        None,
        Published,
        Rejected,
        Finalized,
        Paid
    }

    struct Distribution {
        address token;
        Status status;
        uint64 recordBlock;
        uint64 publishedAt;
        bytes32 merkleRoot;
        uint256 totalPaisa;
        /// Hash of the signed rent statement (income, expenses, net) for the period.
        bytes32 statementHash;
        /// Hash of the bank payout batch file, set once paid.
        bytes32 payoutBatchHash;
    }

    uint256 public constant CHALLENGE_WINDOW = 48 hours;

    address public opsSafe;
    address public trusteeSafe;

    uint256 public distributionCount;
    mapping(uint256 id => Distribution) internal _distributions;

    event OpsSafeSet(address indexed previous, address indexed current);
    event TrusteeSafeSet(address indexed previous, address indexed current);
    event DistributionPublished(
        uint256 indexed id,
        address indexed token,
        uint64 recordBlock,
        bytes32 merkleRoot,
        uint256 totalPaisa,
        bytes32 statementHash
    );
    event DistributionRejected(uint256 indexed id, string reason);
    event DistributionFinalized(uint256 indexed id);
    event PayoutRecorded(uint256 indexed id, bytes32 payoutBatchHash);

    error InvalidDistribution();
    error WrongStatus(uint256 id, Status status);
    error WindowOpen(uint256 id, uint256 closesAt);
    error WindowClosed(uint256 id);

    constructor(address timelock, address opsSafe_, address trusteeSafe_) Governed(timelock) {
        if (opsSafe_ == address(0)) revert ZeroAddress();
        if (trusteeSafe_ == address(0)) revert ZeroAddress();
        opsSafe = opsSafe_;
        trusteeSafe = trusteeSafe_;
        emit OpsSafeSet(address(0), opsSafe_);
        emit TrusteeSafeSet(address(0), trusteeSafe_);
    }

    /// @notice Rotates the Ops Safe.
    /// @dev Timelock only. Reverts on the zero address.
    function setOpsSafe(address opsSafe_) external onlyOwner {
        if (opsSafe_ == address(0)) revert ZeroAddress();
        emit OpsSafeSet(opsSafe, opsSafe_);
        opsSafe = opsSafe_;
    }

    /// @notice Rotates the Trustee Safe.
    /// @dev Timelock only. Reverts on the zero address.
    function setTrusteeSafe(address trusteeSafe_) external onlyOwner {
        if (trusteeSafe_ == address(0)) revert ZeroAddress();
        emit TrusteeSafeSet(trusteeSafe, trusteeSafe_);
        trusteeSafe = trusteeSafe_;
    }

    /// @notice Publishes a rent distribution and opens the challenge window.
    /// @dev Ops Safe only.
    /// @param token Property token the distribution belongs to.
    /// @param recordBlock Block at which holdings were measured; must be in the past.
    /// @param merkleRoot Root of (wallet, amountPaisa) entitlements.
    /// @param totalPaisa Sum of all entitlements, in paisa.
    /// @param statementHash Hash of the signed rent statement.
    /// @return id Distribution ID.
    function publish(address token, uint64 recordBlock, bytes32 merkleRoot, uint256 totalPaisa, bytes32 statementHash)
        external
        returns (uint256 id)
    {
        if (msg.sender != opsSafe) revert Unauthorized(msg.sender);
        if (
            token == address(0) || recordBlock >= block.number || merkleRoot == bytes32(0) || totalPaisa == 0
                || statementHash == bytes32(0)
        ) revert InvalidDistribution();

        id = ++distributionCount;
        _distributions[id] = Distribution({
            token: token,
            status: Status.Published,
            recordBlock: recordBlock,
            // Safe cast: uint64 seconds overflow in year 584 billion.
            // forge-lint: disable-next-line(unsafe-typecast)
            publishedAt: uint64(block.timestamp),
            merkleRoot: merkleRoot,
            totalPaisa: totalPaisa,
            statementHash: statementHash,
            payoutBatchHash: bytes32(0)
        });
        emit DistributionPublished(id, token, recordBlock, merkleRoot, totalPaisa, statementHash);
    }

    /// @notice Rejects a distribution during its challenge window.
    /// @dev Trustee Safe only.
    /// @param id Distribution ID.
    /// @param reason Free-text reason, recorded in the event.
    function reject(uint256 id, string calldata reason) external {
        if (msg.sender != trusteeSafe) revert Unauthorized(msg.sender);
        Distribution storage d = _requireStatus(id, Status.Published);
        // Timestamp use is intentional: delays are hours long and QBFT validators can skew time by seconds only.
        // slither-disable-start timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp >= d.publishedAt + CHALLENGE_WINDOW) revert WindowClosed(id);
        // slither-disable-end timestamp
        d.status = Status.Rejected;
        emit DistributionRejected(id, reason);
    }

    /// @notice Anyone may finalize once the challenge window has passed without rejection.
    /// @param id Distribution ID.
    function finalize(uint256 id) external {
        Distribution storage d = _requireStatus(id, Status.Published);
        uint256 closesAt = d.publishedAt + CHALLENGE_WINDOW;
        // Timestamp use is intentional: delays are hours long and QBFT validators can skew time by seconds only.
        // slither-disable-start timestamp
        // forge-lint: disable-next-line(block-timestamp)
        if (block.timestamp < closesAt) revert WindowOpen(id, closesAt);
        // slither-disable-end timestamp
        d.status = Status.Finalized;
        emit DistributionFinalized(id);
    }

    /// @notice Records that the bank has paid a finalized distribution.
    /// @dev Ops Safe only. Once per distribution.
    /// @param id Distribution ID.
    /// @param payoutBatchHash Hash of the bank payout batch file; must be non-zero.
    function recordPayout(uint256 id, bytes32 payoutBatchHash) external {
        if (msg.sender != opsSafe) revert Unauthorized(msg.sender);
        if (payoutBatchHash == bytes32(0)) revert InvalidDistribution();
        Distribution storage d = _requireStatus(id, Status.Finalized);
        d.status = Status.Paid;
        d.payoutBatchHash = payoutBatchHash;
        emit PayoutRecorded(id, payoutBatchHash);
    }

    /// @notice Lets any investor check their own entitlement against a published root.
    /// @param id Distribution ID.
    /// @param account Investor wallet.
    /// @param amountPaisa Claimed entitlement, in paisa.
    /// @param proof Merkle proof for the (account, amountPaisa) leaf.
    /// @return True if the leaf is in the distribution's tree.
    function verify(uint256 id, address account, uint256 amountPaisa, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        bytes32 root = _distributions[id].merkleRoot;
        // Unknown ID: a zero root is the "not published" marker, not a balance.
        // slither-disable-next-line incorrect-equality,timestamp
        if (root == bytes32(0)) return false;
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amountPaisa))));
        return MerkleProof.verifyCalldata(proof, root, leaf);
    }

    /// @notice Returns a distribution.
    /// @param id Distribution ID.
    function getDistribution(uint256 id) external view returns (Distribution memory) {
        return _distributions[id];
    }

    function _requireStatus(uint256 id, Status expected) private view returns (Distribution storage d) {
        d = _distributions[id];
        if (d.status != expected) revert WrongStatus(id, d.status);
    }
}
