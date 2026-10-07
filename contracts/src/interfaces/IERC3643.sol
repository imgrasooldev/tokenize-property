// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

/// @notice Minimal view of the ERC-3643 token used by our guards.
/// @dev Signatures mirror lib/erc3643/contracts/token/IToken.sol at tag 4.1.3. Kept local so our
///      code compiles with a newer solc than the vendored suite (which pins 0.8.17).
interface IERC3643Token {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function paused() external view returns (bool);
    function isFrozen(address account) external view returns (bool);
    function getFrozenTokens(address account) external view returns (uint256);
    function identityRegistry() external view returns (address);

    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
    function pause() external;
    function unpause() external;
    function setAddressFrozen(address account, bool freeze) external;
    function freezePartialTokens(address account, uint256 amount) external;
    function unfreezePartialTokens(address account, uint256 amount) external;
    function forcedTransfer(address from, address to, uint256 amount) external returns (bool);
    function recoveryAddress(address lostWallet, address newWallet, address investorOnchainId) external returns (bool);
}

/// @notice Minimal view of the ERC-3643 identity registry used by our guards.
interface IERC3643IdentityRegistry {
    function registerIdentity(address account, address identity, uint16 country) external;
    function contains(address account) external view returns (bool);
    function isVerified(address account) external view returns (bool);
}
