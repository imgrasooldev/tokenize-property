// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Governed} from "../common/Governed.sol";

/// @title DocumentRegistry
/// @notice Append-only record of document hashes per token (title deed, valuations, insurance,
///         audits, court orders). Nothing is ever deleted or overwritten; a newer document can only
///         mark an older one as superseded. Spec: docs/contract-spec.md section 6.2.
contract DocumentRegistry is Governed {
    enum DocType {
        TitleDeed,
        LandRecord,
        Valuation,
        Insurance,
        TrustDeed,
        AuditReport,
        ShariahCertificate,
        CourtOrder,
        InvestorVote,
        Other
    }

    struct Document {
        address token;
        DocType docType;
        uint64 addedAt;
        bytes32 sha256Hash;
        /// 0 while current; otherwise the ID of the document that replaced it.
        uint256 supersededBy;
        string uri;
    }

    uint256 public constant MAX_URI_LENGTH = 512;

    address public opsSafe;
    uint256 public documentCount;
    mapping(uint256 id => Document) internal _documents;

    event OpsSafeSet(address indexed previous, address indexed current);
    event DocumentAdded(uint256 indexed id, address indexed token, DocType docType, bytes32 sha256Hash, string uri);
    event DocumentSuperseded(uint256 indexed oldId, uint256 indexed newId);

    error InvalidDocument();
    error InvalidSupersede(uint256 oldId, uint256 newId);

    modifier onlyOps() {
        if (msg.sender != opsSafe) revert Unauthorized(msg.sender);
        _;
    }

    constructor(address timelock, address opsSafe_) Governed(timelock) {
        if (opsSafe_ == address(0)) revert ZeroAddress();
        opsSafe = opsSafe_;
        emit OpsSafeSet(address(0), opsSafe_);
    }

    /// @notice Rotates the Ops Safe.
    /// @dev Timelock only. Reverts on the zero address.
    function setOpsSafe(address opsSafe_) external onlyOwner {
        if (opsSafe_ == address(0)) revert ZeroAddress();
        emit OpsSafeSet(opsSafe, opsSafe_);
        opsSafe = opsSafe_;
    }

    /// @notice Records a document hash for a property token.
    /// @dev Ops Safe only.
    /// @param token Property token.
    /// @param docType Kind of document.
    /// @param sha256Hash SHA-256 of the file; must be non-zero.
    /// @param uri Location in the private document store (no personal data); 1-512 bytes.
    /// @return id Document ID.
    function add(address token, DocType docType, bytes32 sha256Hash, string calldata uri)
        external
        onlyOps
        returns (uint256 id)
    {
        uint256 uriLength = bytes(uri).length;
        if (token == address(0) || sha256Hash == bytes32(0) || uriLength == 0 || uriLength > MAX_URI_LENGTH) {
            revert InvalidDocument();
        }
        id = ++documentCount;
        _documents[id] = Document({
            token: token,
            docType: docType,
            // Safe cast: uint64 seconds overflow in year 584 billion.
            // forge-lint: disable-next-line(unsafe-typecast)
            addedAt: uint64(block.timestamp),
            sha256Hash: sha256Hash,
            supersededBy: 0,
            uri: uri
        });
        emit DocumentAdded(id, token, docType, sha256Hash, uri);
    }

    /// @notice Marks `oldId` as replaced by `newId`. Both must belong to the same token and be
    ///         current; a document cannot supersede itself.
    /// @param oldId Document being replaced.
    /// @param newId Replacement document.
    function supersede(uint256 oldId, uint256 newId) external onlyOps {
        Document storage oldDoc = _documents[oldId];
        Document storage newDoc = _documents[newId];
        if (
            oldId == newId || oldDoc.token == address(0) || newDoc.token != oldDoc.token || oldDoc.supersededBy != 0
                || newDoc.supersededBy != 0
        ) revert InvalidSupersede(oldId, newId);
        oldDoc.supersededBy = newId;
        emit DocumentSuperseded(oldId, newId);
    }

    /// @notice Returns a document record.
    /// @param id Document ID.
    function getDocument(uint256 id) external view returns (Document memory) {
        return _documents[id];
    }
}
