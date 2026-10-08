"""End-to-end flow on the local Besu network (Step 4).

Deploys the full system through script/DeployLib.sol (the same code production uses), then walks a
real lifecycle with real blocks and checks every result on-chain:

  deploy + hand-over checks -> go-live (timelock cap, Admin Safe unpause) -> onboarding with signed
  KYC/AML claims -> mint -> transfer -> limits and attacks that must fail -> pause/unpause ->
  freeze -> rent distribution with Merkle proof -> recovery proposal/cancel -> validator outage.

Usage (network must be running):  python chain/flow.py
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

CHAIN = Path(__file__).resolve().parent
ROOT = CHAIN.parent
CONTRACTS = ROOT / "contracts"
sys.path.insert(0, str(CHAIN))
import net  # noqa: E402

RPC = f"http://{net.HOST}:{net.RPC_BASE}"
TIMELOCK_DELAY = 60  # allowed only on the local dev chain ID (see DeployLib.minTimelockDelay)
CAP = 1_000_000
MAX_BALANCE = 100_000
PAKISTAN = 586

ACC = net.load_accounts()
CAST = net.foundry("cast")
FORGE = net.foundry("forge")

passed = 0


def check(cond, label):
    global passed
    if not cond:
        sys.exit(f"  FAIL  {label}")
    passed += 1
    print(f"  ok    {label}")


def cast(*args, key=None):
    cmd = [CAST, *args]
    if args and args[0] in ("send", "call", "block-number", "chain-id"):
        cmd += ["--rpc-url", RPC]
    if key:
        # Local dev key only; handed to the child process, never printed.
        cmd += ["--private-key", ACC[f"{key}_KEY"]]
    return subprocess.run(cmd, capture_output=True, text=True)


def call(to, sig, *args):
    r = cast("call", to, sig, *[str(a) for a in args])
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout.strip().split(" ")[0]


def send(role, to, sig, *args):
    """Returns (succeeded, reverted, message). `reverted` is True only for a contract revert."""
    r = cast("send", to, sig, *[str(a) for a in args], "--json", key=role)
    out = r.stdout.strip()
    try:
        parsed = json.loads(out) if out else {}
    except json.JSONDecodeError:
        parsed = {}
    receipt = parsed.get("data", parsed) if isinstance(parsed, dict) else {}
    if r.returncode == 0 and isinstance(receipt, dict) and receipt.get("status") in ("0x1", 1, "1"):
        return True, False, ""
    message = " ".join(e.get("message", "") for e in parsed.get("errors", [])) if isinstance(parsed, dict) else ""
    message = " ".join((message or r.stderr or out).split())
    reverted = "revert" in message.lower() or (isinstance(receipt, dict) and receipt.get("status") in ("0x0", 0))
    return False, reverted, message[:300]


def must_send(role, to, sig, *args, label):
    ok, _, err = send(role, to, sig, *args)
    check(ok, f"{label}" + ("" if ok else f" ({err})"))


def must_fail(role, to, sig, *args, label=None):
    """Passes only if the contract itself reverts; tooling or connection errors abort the run."""
    ok, reverted, err = send(role, to, sig, *args)
    name = label or role + " calling " + sig.split("(")[0]
    if not ok and not reverted:
        sys.exit(f"  ERROR {name}: failed for a reason other than a revert: {err}")
    check(reverted, f"{name} is refused (reverted)")


def wait_seconds(seconds, why):
    print(f"  ...   waiting {seconds}s ({why})")
    time.sleep(seconds)


# ------------------------------------------------------------------ steps


def deploy():
    print("\n[1] Deploy through DeployLib (production code path)")
    env = dict(os.environ)
    env.update({
        "DEPLOYER": ACC["DEPLOYER"], "ADMIN_SAFE": ACC["ADMIN_SAFE"], "TRUSTEE_SAFE": ACC["TRUSTEE_SAFE"],
        "ISSUANCE_SAFE": ACC["ISSUANCE_SAFE"], "OPS_SAFE": ACC["OPS_SAFE"], "PAUSER": ACC["PAUSER"],
        "REGISTRAR": ACC["REGISTRAR"], "IDENTITY_OPERATOR": ACC["IDENTITY_OPERATOR"],
        "CLAIM_ISSUER_MANAGER": ACC["ADMIN_SAFE"], "CLAIM_SIGNER": ACC["CLAIM_SIGNER"],
        "TIMELOCK_DELAY": str(TIMELOCK_DELAY), "MAX_BALANCE": str(MAX_BALANCE), "ALLOWED_COUNTRIES": str(PAKISTAN),
        "LOCAL_DEV_NETWORK": "true",
        "TOKEN_SALT": f"GPF3-{int(time.time())}", "TOKEN_NAME": "Gulberg Plaza Floor 3", "TOKEN_SYMBOL": "GPF3",
    })
    # Local dev key only; passed to the child process, never printed. Production deploys use an
    # encrypted keystore or a hardware wallet (see script/Deploy.s.sol).
    r = subprocess.run(
        [FORGE, "script", "script/Deploy.s.sol", "--rpc-url", RPC, "--broadcast", "--slow",
         "--private-key", ACC["DEPLOYER_KEY"]],
        cwd=CONTRACTS, env=env, capture_output=True, text=True,
    )
    check(r.returncode == 0 and "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" in r.stdout,
          "deploy script broadcast and post-deploy checks (I-8, I-9) passed"
          + ("" if r.returncode == 0 else "\n" + r.stderr[-1500:]))
    run = json.loads((CONTRACTS / "broadcast" / "Deploy.s.sol" / str(net.CHAIN_ID) / "run-latest.json").read_text())
    names = ["timelock", "oidAuthority", "trexAuthority", "idFactory", "factory", "claimIssuer", "countryModule",
             "maxBalanceModule", "token", "ir", "issuance", "pauseGuard", "freezeGuard", "recovery",
             "registrarGuard", "distributions", "documents"]
    values = re.findall(r"0x[0-9a-fA-F]{40}", run["returns"]["d"]["value"])
    d = dict(zip(names, values))
    check(len(d) == len(names), f"{len(names)} contract addresses recovered from the broadcast")
    return d


def go_live(d):
    print("\n[2] Go-live: trustee cap through the timelock, then Admin Safe unpauses")
    tl, issuance = d["timelock"], d["issuance"]
    check(call(d["token"], "paused()(bool)") == "true", "token starts paused")
    data = cast("calldata", "setTrusteeCap(uint256)", str(CAP)).stdout.strip()
    salt = "0x" + "01".rjust(64, "0")
    zero = "0x" + "0" * 64
    must_fail("DEPLOYER", issuance, "setTrusteeCap(uint256)", CAP, label="deployer setting the cap directly")
    must_send("ADMIN_SAFE", tl, "schedule(address,uint256,bytes,bytes32,bytes32,uint256)",
              issuance, 0, data, zero, salt, TIMELOCK_DELAY, label="Admin Safe schedules setTrusteeCap")
    must_fail("ADMIN_SAFE", tl, "execute(address,uint256,bytes,bytes32,bytes32)",
              issuance, 0, data, zero, salt, label="executing before the delay")
    wait_seconds(TIMELOCK_DELAY + 4, "timelock delay")
    must_send("ADMIN_SAFE", tl, "execute(address,uint256,bytes,bytes32,bytes32)",
              issuance, 0, data, zero, salt, label="timelock executes setTrusteeCap")
    check(call(issuance, "trusteeCap()(uint256)") == str(CAP), f"trustee cap is {CAP:,}")
    must_fail("PAUSER", d["pauseGuard"], "unpause()", label="pauser unpausing")
    must_send("ADMIN_SAFE", d["pauseGuard"], "unpause()", label="Admin Safe unpauses (go-live)")
    check(call(d["token"], "paused()(bool)") == "false", "token is live")


def claim_signature(identity, topic, data_hex):
    encoded = cast("abi-encode", "f(address,uint256,bytes)", identity, str(topic), data_hex).stdout.strip()
    data_hash = cast("keccak", encoded).stdout.strip()
    r = cast("wallet", "sign", data_hash, key="CLAIM_SIGNER")  # EIP-191 prefix, as ONCHAINID expects
    return r.stdout.strip()


def onboard(d, role, salt):
    wallet = ACC[role]
    ok, _, err = send("IDENTITY_OPERATOR", d["idFactory"], "createIdentity(address,string)", wallet, salt)
    check(ok, f"identity operator creates ONCHAINID for {role}" + ("" if ok else f" ({err})"))
    identity = call(d["idFactory"], "getIdentity(address)(address)", wallet)
    for topic in (1, 2):
        data_hex = cast("abi-encode", "f(string,uint256)", "verified", str(topic)).stdout.strip()
        sig = claim_signature(identity, topic, data_hex)
        must_send(role, identity, "addClaim(uint256,uint256,address,bytes,bytes,string)",
                  topic, 1, d["claimIssuer"], sig, data_hex, "",
                  label=f"{role} adds {'KYC' if topic == 1 else 'AML'} claim signed by the HSM claim signer")
    must_send("REGISTRAR", d["registrarGuard"], "register(address,address,uint16)", wallet, identity, PAKISTAN,
              label=f"registrar registers {role}")
    check(call(d["ir"], "isVerified(address)(bool)", wallet) == "true", f"{role} is verified")
    return identity


def token_flows(d):
    print("\n[3] Onboarding with signed KYC/AML claims")
    onboard(d, "ALICE", f"alice-{int(time.time())}")
    onboard(d, "BOB", f"bob-{int(time.time())}")
    must_fail("REGISTRAR", d["registrarGuard"], "register(address,address,uint16)", ACC["ALICE_NEW_WALLET"],
              ACC["ALICE_NEW_WALLET"], PAKISTAN, label="registering a wallet without a verified identity")

    print("\n[4] Mint, transfer and limits")
    t, a, b = d["token"], ACC["ALICE"], ACC["BOB"]
    must_send("ISSUANCE_SAFE", d["issuance"], "mint(address,uint256,bytes32)", a, 60_000, "0x" + "a1" * 32,
              label="Issuance Safe mints 60,000 to Alice")
    must_fail("ISSUANCE_SAFE", d["issuance"], "mint(address,uint256,bytes32)", a, 1, "0x" + "a1" * 32,
              label="re-using a subscription reference")
    must_fail("ISSUANCE_SAFE", d["issuance"], "mint(address,uint256,bytes32)", a, 50_000, "0x" + "a2" * 32,
              label="minting Alice above the 10% per-investor limit")
    must_fail("DEPLOYER", d["issuance"], "mint(address,uint256,bytes32)", a, 1, "0x" + "a3" * 32,
              label="deployer minting")
    must_fail("ISSUANCE_SAFE", d["issuance"], "mint(address,uint256,bytes32)", ACC["ALICE_NEW_WALLET"], 1,
              "0x" + "a4" * 32, label="minting to an unverified wallet")
    must_send("ALICE", t, "transfer(address,uint256)", b, 10_000, label="Alice transfers 10,000 to Bob")
    must_fail("ALICE", t, "transfer(address,uint256)", ACC["ALICE_NEW_WALLET"], 1,
              label="transfer to an unverified wallet")
    check(call(t, "balanceOf(address)(uint256)", a) == "50000", "Alice holds 50,000")
    check(call(t, "balanceOf(address)(uint256)", b) == "10000", "Bob holds 10,000")
    check(call(t, "totalSupply()(uint256)") == "60000", "total supply 60,000 (within trustee cap)")

    print("\n[5] Pause, freeze")
    must_send("PAUSER", d["pauseGuard"], "pause(string)", "incident drill", label="pauser pauses")
    must_fail("ALICE", t, "transfer(address,uint256)", b, 1, label="transfer while paused")
    must_fail("PAUSER", d["pauseGuard"], "unpause()", label="pauser unpausing")
    must_send("ADMIN_SAFE", d["pauseGuard"], "unpause()", label="Admin Safe unpauses")
    must_send("OPS_SAFE", d["freezeGuard"], "freezeAddress(address,bytes32)", b, "0x" + "c0" * 32,
              label="Ops Safe freezes Bob (case file attached)")
    must_fail("BOB", t, "transfer(address,uint256)", a, 1, label="transfer from a frozen wallet")
    must_send("OPS_SAFE", d["freezeGuard"], "unfreezeAddress(address,bytes32)", b, "0x" + "c0" * 32,
              label="Ops Safe unfreezes Bob")


def distribution(d):
    print("\n[6] Rent distribution with Merkle proof")
    a, b = ACC["ALICE"], ACC["BOB"]
    amounts = {a: 2_500_000, b: 500_000}  # paisa
    leaves = {}
    for acct, amt in amounts.items():
        inner = cast("keccak", cast("abi-encode", "f(address,uint256)", acct, str(amt)).stdout.strip()).stdout.strip()
        leaves[acct] = cast("keccak", inner).stdout.strip()
    la, lb = leaves[a], leaves[b]
    lo, hi = sorted([la, lb], key=lambda x: int(x, 16))
    root = cast("keccak", lo + hi[2:]).stdout.strip()
    height = int(cast("block-number").stdout.strip())
    must_send("OPS_SAFE", d["distributions"], "publish(address,uint64,bytes32,uint256,bytes32)",
              d["token"], height - 1, root, sum(amounts.values()), "0x" + "5e" * 32,
              label="Ops Safe publishes September rent (Rs 30,000) as a Merkle root")
    check(call(d["distributions"], "verify(uint256,address,uint256,bytes32[])(bool)", 1, a, amounts[a], f"[{lb}]")
          == "true", "Alice verifies her own Rs 25,000 entitlement")
    check(call(d["distributions"], "verify(uint256,address,uint256,bytes32[])(bool)", 1, a, amounts[a] + 1, f"[{lb}]")
          == "false", "a wrong amount does not verify")
    must_fail("OPS_SAFE", d["distributions"], "finalize(uint256)", 1,
              label="finalizing before the 48h challenge window closes")


def recovery(d):
    print("\n[7] Recovery request (48h delay) can be proposed and cancelled")
    must_send("TRUSTEE_SAFE", d["recovery"], "propose(uint8,address,address,address,uint256,bytes32)",
              1, ACC["BOB"], ACC["ALICE"], "0x" + "0" * 40, 1_000, "0x" + "e1" * 32,
              label="Trustee Safe proposes a forced transfer")
    must_fail("TRUSTEE_SAFE", d["recovery"], "execute(uint256)", 1, label="executing before the 48h delay")
    must_send("ADMIN_SAFE", d["recovery"], "cancel(uint256)", 1, label="Admin Safe cancels it")


def outage(d):
    print("\n[8] Validator outage: QBFT keeps producing blocks with 3 of 4 validators")
    net.cmd_stop(["node4"])
    h1 = int(cast("block-number").stdout.strip())
    time.sleep(10)
    h2 = int(cast("block-number").stdout.strip())
    check(h2 > h1, f"blocks continue with node4 down ({h1} -> {h2})")
    must_send("ALICE", d["token"], "transfer(address,uint256)", ACC["BOB"], 1, label="transactions still confirm")
    net.cmd_start(["node4"])
    n1 = n4 = -1
    deadline = time.time() + 90  # JVM start-up plus sync
    while time.time() < deadline:
        try:
            n4 = int(net.rpc(net.RPC_BASE + 3, "eth_blockNumber"), 16)
            n1 = int(net.rpc(net.RPC_BASE, "eth_blockNumber"), 16)
            if abs(n1 - n4) <= 2:
                break
        except Exception:
            pass
        time.sleep(2)
    check(n4 >= 0 and abs(n1 - n4) <= 2, f"node4 rejoins and catches up (node1 {n1}, node4 {n4})")


def main():
    try:
        net.rpc(net.RPC_BASE, "eth_blockNumber")
    except Exception:
        sys.exit("Network not running. Start it with: python chain/net.py start")
    check(int(cast("chain-id").stdout.strip()) == net.CHAIN_ID, f"connected to local dev chain {net.CHAIN_ID}")
    d = deploy()
    go_live(d)
    token_flows(d)
    distribution(d)
    recovery(d)
    outage(d)
    print(f"\nAll {passed} checks passed. Token: {d['token']}")


if __name__ == "__main__":
    main()
