// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Governed} from "../common/Governed.sol";
import {IERC3643Token} from "../interfaces/IERC3643.sol";

/// @title FreezeGuard
/// @notice Freezes and unfreezes investor balances for compliance cases. Every action must carry a
///         case ID that links to the off-chain case file. Spec: docs/contract-spec.md section 5.3.
contract FreezeGuard is Governed {
    IERC3643Token public immutable token;

    address public opsSafe;

    event OpsSafeSet(address indexed previous, address indexed current);
    event AddressFreezeSet(address indexed account, bool frozen, bytes32 indexed caseId);
    event PartialFreezeSet(address indexed account, uint256 amount, bool frozen, bytes32 indexed caseId);

    error MissingCaseId();

    modifier onlyOps(bytes32 caseId) {
        if (msg.sender != opsSafe) revert Unauthorized(msg.sender);
        if (caseId == bytes32(0)) revert MissingCaseId();
        _;
    }

    constructor(address timelock, IERC3643Token token_, address opsSafe_) Governed(timelock) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (opsSafe_ == address(0)) revert ZeroAddress();
        token = token_;
        opsSafe = opsSafe_;
        emit OpsSafeSet(address(0), opsSafe_);
    }

    function setOpsSafe(address opsSafe_) external onlyOwner {
        if (opsSafe_ == address(0)) revert ZeroAddress();
        emit OpsSafeSet(opsSafe, opsSafe_);
        opsSafe = opsSafe_;
    }

    function freezeAddress(address account, bytes32 caseId) external onlyOps(caseId) {
        emit AddressFreezeSet(account, true, caseId);
        token.setAddressFrozen(account, true);
    }

    function unfreezeAddress(address account, bytes32 caseId) external onlyOps(caseId) {
        emit AddressFreezeSet(account, false, caseId);
        token.setAddressFrozen(account, false);
    }

    function freezePartial(address account, uint256 amount, bytes32 caseId) external onlyOps(caseId) {
        emit PartialFreezeSet(account, amount, true, caseId);
        token.freezePartialTokens(account, amount);
    }

    function unfreezePartial(address account, uint256 amount, bytes32 caseId) external onlyOps(caseId) {
        emit PartialFreezeSet(account, amount, false, caseId);
        token.unfreezePartialTokens(account, amount);
    }
}
