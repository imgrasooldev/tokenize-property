// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Governed} from "../common/Governed.sol";
import {IERC3643Token} from "../interfaces/IERC3643.sol";

/// @title PauseGuard
/// @notice Splits pause from unpause. ERC-3643 lets any agent do both; here a hot pauser key, the
///         Ops Safe or the Admin Safe can pause, but only the Admin Safe can unpause.
///         Spec: docs/contract-spec.md section 5.2.
contract PauseGuard is Governed {
    IERC3643Token public immutable token;

    address public pauser;
    address public opsSafe;
    address public adminSafe;

    event PauserSet(address indexed previous, address indexed current);
    event OpsSafeSet(address indexed previous, address indexed current);
    event AdminSafeSet(address indexed previous, address indexed current);
    event Paused(address indexed by, string reason);
    event Unpaused(address indexed by);

    constructor(address timelock, IERC3643Token token_, address pauser_, address opsSafe_, address adminSafe_)
        Governed(timelock)
    {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (pauser_ == address(0)) revert ZeroAddress();
        if (opsSafe_ == address(0)) revert ZeroAddress();
        if (adminSafe_ == address(0)) revert ZeroAddress();
        token = token_;
        pauser = pauser_;
        opsSafe = opsSafe_;
        adminSafe = adminSafe_;
        emit PauserSet(address(0), pauser_);
        emit OpsSafeSet(address(0), opsSafe_);
        emit AdminSafeSet(address(0), adminSafe_);
    }

    function pause(string calldata reason) external {
        if (msg.sender != pauser && msg.sender != opsSafe && msg.sender != adminSafe) {
            revert Unauthorized(msg.sender);
        }
        emit Paused(msg.sender, reason);
        token.pause();
    }

    function unpause() external {
        if (msg.sender != adminSafe) revert Unauthorized(msg.sender);
        emit Unpaused(msg.sender);
        token.unpause();
    }

    function setPauser(address pauser_) external onlyOwner {
        if (pauser_ == address(0)) revert ZeroAddress();
        emit PauserSet(pauser, pauser_);
        pauser = pauser_;
    }

    function setOpsSafe(address opsSafe_) external onlyOwner {
        if (opsSafe_ == address(0)) revert ZeroAddress();
        emit OpsSafeSet(opsSafe, opsSafe_);
        opsSafe = opsSafe_;
    }

    function setAdminSafe(address adminSafe_) external onlyOwner {
        if (adminSafe_ == address(0)) revert ZeroAddress();
        emit AdminSafeSet(adminSafe, adminSafe_);
        adminSafe = adminSafe_;
    }
}
