// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";

/// @title Governed
/// @notice Base for every guard and registry. The owner is the TimelockController.
/// @dev Two-step ownership transfer prevents handing control to a mistyped address.
///      Renouncing ownership is disabled: a contract without an owner could never rotate a
///      compromised key.
abstract contract Governed is Ownable2Step {
    error ZeroAddress();
    error RenounceDisabled();
    error Unauthorized(address caller);

    constructor(address timelock) Ownable(timelock) {}

    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }
}
