// SPDX-License-Identifier: GPL-3.0-only
pragma solidity 0.8.30;

import {Test} from "forge-std/Test.sol";
import {Fixture} from "../helpers/Fixture.sol";
import {ITokenFull} from "../../script/VendorInterfaces.sol";
import {IssuanceGuard} from "../../src/guards/IssuanceGuard.sol";
import {PauseGuard} from "../../src/guards/PauseGuard.sol";
import {FreezeGuard} from "../../src/guards/FreezeGuard.sol";

/// @notice Drives random sequences of privileged and unprivileged actions against the live system.
///         Ghost variables record any action that should have been impossible.
contract Handler is Test {
    ITokenFull internal token;
    IssuanceGuard internal issuance;
    PauseGuard internal pauseGuard;
    FreezeGuard internal freezeGuard;
    address internal issuanceSafe;
    address internal adminSafe;
    address internal opsSafe;
    address internal pauser;

    address[] public actors; // verified investors followed by unverified wallets
    uint256 public verifiedCount;
    address[] internal privileged;

    uint256 internal _ref;

    // Ghosts: each must stay zero.
    uint256 public ghostUnpauseByNonAdmin;
    uint256 public ghostTransferWhilePaused;
    uint256 public ghostSendFromFrozen;
    uint256 public ghostMintByNonIssuer;

    constructor(
        ITokenFull token_,
        IssuanceGuard issuance_,
        PauseGuard pauseGuard_,
        FreezeGuard freezeGuard_,
        address[] memory actors_,
        uint256 verifiedCount_,
        address[] memory privileged_
    ) {
        token = token_;
        issuance = issuance_;
        pauseGuard = pauseGuard_;
        freezeGuard = freezeGuard_;
        actors = actors_;
        verifiedCount = verifiedCount_;
        privileged = privileged_;
        issuanceSafe = privileged_[0];
        adminSafe = privileged_[1];
        opsSafe = privileged_[2];
        pauser = privileged_[3];
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _caller(uint256 seed) internal view returns (address) {
        // Mix privileged keys and investors as callers.
        uint256 i = seed % (privileged.length + actors.length);
        return i < privileged.length ? privileged[i] : actors[i - privileged.length];
    }

    function mint(uint256 toSeed, uint256 amount, uint256 callerSeed) external {
        address to = _actor(toSeed);
        amount = bound(amount, 1, 50_000);
        address caller = callerSeed % 4 == 0 ? _caller(callerSeed) : issuanceSafe;
        vm.prank(caller);
        try issuance.mint(to, amount, bytes32(++_ref)) {
            if (caller != issuanceSafe) ++ghostMintByNonIssuer;
        } catch {}
    }

    function burn(uint256 fromSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(issuanceSafe);
        try issuance.burn(from, amount, bytes32(++_ref)) {} catch {}
    }

    function transfer(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = _actor(fromSeed);
        address to = _actor(toSeed);
        amount = bound(amount, 0, token.balanceOf(from));
        bool wasPaused = token.paused();
        bool wasFrozen = token.isFrozen(from);
        vm.prank(from);
        try token.transfer(to, amount) {
            if (wasPaused) ++ghostTransferWhilePaused;
            if (wasFrozen) ++ghostSendFromFrozen;
        } catch {}
    }

    function pause(uint256 callerSeed) external {
        vm.prank(_caller(callerSeed));
        try pauseGuard.pause("fuzz") {} catch {}
    }

    function unpause(uint256 callerSeed) external {
        address caller = callerSeed % 3 == 0 ? adminSafe : _caller(callerSeed);
        vm.prank(caller);
        try pauseGuard.unpause() {
            if (caller != adminSafe) ++ghostUnpauseByNonAdmin;
        } catch {}
    }

    function freeze(uint256 actorSeed, bool frozen) external {
        address account = _actor(actorSeed);
        vm.prank(opsSafe);
        if (frozen) freezeGuard.freezeAddress(account, bytes32("CASE"));
        else freezeGuard.unfreezeAddress(account, bytes32("CASE"));
    }

    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 3 days));
    }
}

contract TokenInvariantsTest is Fixture {
    Handler internal handler;
    uint256 internal constant VERIFIED = 4;
    uint256 internal constant UNVERIFIED = 2;

    function setUp() public override {
        super.setUp();
        address[] memory actors = new address[](VERIFIED + UNVERIFIED);
        for (uint256 i; i < VERIFIED; ++i) {
            actors[i] = makeAddr(string.concat("investor", vm.toString(i)));
            _onboard(actors[i]);
        }
        for (uint256 i; i < UNVERIFIED; ++i) {
            actors[VERIFIED + i] = makeAddr(string.concat("stranger", vm.toString(i)));
        }
        address[] memory privileged = new address[](4);
        privileged[0] = issuanceSafe;
        privileged[1] = adminSafe;
        privileged[2] = opsSafe;
        privileged[3] = pauser;

        handler = new Handler(token, issuance, pauseGuard, freezeGuard, actors, VERIFIED, privileged);
        targetContract(address(handler));
    }

    /// I-1: balances sum to total supply (all possible holders are in the actor set).
    function invariant_I1_balancesSumToSupply() public view {
        uint256 sum;
        for (uint256 i; i < handler.actorCount(); ++i) {
            sum += token.balanceOf(handler.actors(i));
        }
        assertEq(sum, token.totalSupply());
    }

    /// I-2: supply never exceeds the trustee register.
    function invariant_I2_supplyWithinTrusteeCap() public view {
        assertLe(token.totalSupply(), issuance.trusteeCap());
    }

    /// I-3 / I-4: unverified wallets never hold tokens.
    function invariant_I3_unverifiedHoldNothing() public view {
        for (uint256 i = handler.verifiedCount(); i < handler.actorCount(); ++i) {
            assertEq(token.balanceOf(handler.actors(i)), 0);
        }
    }

    /// I-5: a frozen wallet never sends.
    function invariant_I5_frozenNeverSends() public view {
        assertEq(handler.ghostSendFromFrozen(), 0);
    }

    /// I-6: no ordinary transfer while paused.
    function invariant_I6_noTransferWhilePaused() public view {
        assertEq(handler.ghostTransferWhilePaused(), 0);
    }

    /// I-8: agent set unchanged by any sequence of actions.
    function invariant_I8_agentsUnchanged() public view {
        assertTrue(token.isAgent(address(issuance)));
        assertTrue(token.isAgent(address(pauseGuard)));
        assertTrue(token.isAgent(address(freezeGuard)));
        assertTrue(token.isAgent(address(recovery)));
        assertFalse(token.isAgent(issuanceSafe));
        assertFalse(token.isAgent(pauser));
    }

    /// I-10: only the Admin Safe ever unpauses.
    function invariant_I10_onlyAdminUnpauses() public view {
        assertEq(handler.ghostUnpauseByNonAdmin(), 0);
    }

    /// I-17: the max-balance module's per-identity record equals the real balance and never exceeds the
    ///       per-investor limit (each verified actor has its own ONCHAINID here).
    function invariant_I17_maxBalanceTrackingMatchesAndHolds() public view {
        address mc = token.compliance();
        for (uint256 i; i < handler.verifiedCount(); ++i) {
            address actor = handler.actors(i);
            uint256 tracked = maxBalanceModule.getIDBalance(mc, identityOf[actor]);
            assertEq(tracked, token.balanceOf(actor), "module tracking drifted");
            assertLe(tracked, MAX_BALANCE, "per-investor limit exceeded");
        }
    }

    /// Only the Issuance Safe ever mints.
    function invariant_onlyIssuerMints() public view {
        assertEq(handler.ghostMintByNonIssuer(), 0);
    }
}
