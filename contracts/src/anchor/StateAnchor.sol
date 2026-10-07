// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Governed} from "../common/Governed.sol";

/// @title StateAnchor
/// @notice Deployed on a public chain. Stores hourly block hashes of the private Besu chain so any
///         rewrite of private history is publicly detectable. Spec: docs/contract-spec.md section 7.
/// @dev Owner is a Safe on the public chain (not the private-chain timelock).
contract StateAnchor is Governed {
    address public anchorer;
    uint64 public lastAnchoredBlock;
    mapping(uint64 besuBlock => bytes32 blockHash) public anchors;

    event AnchorerSet(address indexed previous, address indexed current);
    event Anchored(uint64 indexed besuBlock, bytes32 blockHash);

    error NotIncreasing(uint64 besuBlock, uint64 lastAnchoredBlock);
    error ZeroHash();

    constructor(address owner_, address anchorer_) Governed(owner_) {
        if (anchorer_ == address(0)) revert ZeroAddress();
        anchorer = anchorer_;
        emit AnchorerSet(address(0), anchorer_);
    }

    function setAnchorer(address anchorer_) external onlyOwner {
        if (anchorer_ == address(0)) revert ZeroAddress();
        emit AnchorerSet(anchorer, anchorer_);
        anchorer = anchorer_;
    }

    function anchor(uint64 besuBlock, bytes32 blockHash) external {
        if (msg.sender != anchorer) revert Unauthorized(msg.sender);
        if (besuBlock <= lastAnchoredBlock) revert NotIncreasing(besuBlock, lastAnchoredBlock);
        if (blockHash == bytes32(0)) revert ZeroHash();
        lastAnchoredBlock = besuBlock;
        anchors[besuBlock] = blockHash;
        emit Anchored(besuBlock, blockHash);
    }
}
