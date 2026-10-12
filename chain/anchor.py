"""Local stand-in for the public anchor chain (Step 5f-2, ADR 0008).

An Anvil chain on 127.0.0.1:8650 with chain ID 586650 plays the Ethereum L2 that will carry the
hourly StateAnchor anchors until the owner picks the real one. It is a SEPARATE chain from the
private Besu network (586586, ports 8545-8548), exactly as in production.

Usage (from the repository root):
    python chain/anchor.py start      # start Anvil (state kept in chain/data/anchor/state.json)
    python chain/anchor.py status     # chain ID, height, StateAnchor address and last anchored block
    python chain/anchor.py deploy     # deploy StateAnchor through DeployLib (script/DeployAnchor.s.sol)
    python chain/anchor.py stop       # stop Anvil (state is saved every 5 s)
    python chain/anchor.py reset      # stop and delete the stand-in's state

`deploy` uses Anvil's own unlocked dev accounts (no private key leaves Anvil): account 0 deploys,
account 1 stands in for the owner Safe, and the anchor key is the address in the encrypted keystore
created by `npm run anchor:setup` (backend/data/keystore-anchor/anchor.json). It also gives that key
10 ETH of the stand-in's worthless coin for gas.
"""

import json
import os
import shutil
import signal
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

CHAIN = Path(__file__).resolve().parent
ROOT = CHAIN.parent
CONTRACTS = ROOT / "contracts"
DATA = CHAIN / "data" / "anchor"
STATE = DATA / "state.json"
PID_FILE = DATA / "anvil.pid"
LOG_FILE = DATA / "anvil.log"
KEYSTORE = ROOT / "backend" / "data" / "keystore-anchor" / "anchor.json"

HOST = "127.0.0.1"
PORT = 8650  # Besu uses 8545-8548
CHAIN_ID = 586_650  # must equal DeployLib.LOCAL_ANCHOR_CHAIN_ID; never 586586 (the private dev chain)
RPC = f"http://{HOST}:{PORT}"
BROADCAST = CONTRACTS / "broadcast" / "DeployAnchor.s.sol" / str(CHAIN_ID) / "run-latest.json"


def foundry(tool: str) -> str:
    found = shutil.which(tool) or shutil.which(str(Path.home() / ".foundry" / "bin" / tool))
    if not found:
        sys.exit(f"{tool} not found; install Foundry (see MEMORY.md).")
    return found


def rpc(method: str, params=None, timeout=3):
    body = json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params or []}).encode()
    req = urllib.request.Request(RPC, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        out = json.loads(resp.read())
    if "error" in out:
        raise RuntimeError(out["error"])
    return out["result"]


def chain_id():
    try:
        return int(rpc("eth_chainId"), 16)
    except Exception:
        return None


def require_stand_in():
    cid = chain_id()
    if cid is None:
        sys.exit(f"Nothing answers on {RPC}. Run `python chain/anchor.py start` first.")
    if cid != CHAIN_ID:
        sys.exit(f"{RPC} serves chain {cid}, not the anchor stand-in {CHAIN_ID}; refusing.")


def cmd_start(_args):
    if chain_id() is not None:
        print(f"something already answers on {RPC} (chain {chain_id()})")
        return
    DATA.mkdir(parents=True, exist_ok=True)
    args = [foundry("anvil"), "--host", HOST, "--port", str(PORT), "--chain-id", str(CHAIN_ID),
            "--state", str(STATE), "--state-interval", "5", "--quiet"]
    log = open(LOG_FILE, "ab")
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    proc = subprocess.Popen(args, stdout=log, stderr=subprocess.STDOUT, creationflags=flags)
    PID_FILE.write_text(str(proc.pid))
    deadline = time.time() + 30
    while time.time() < deadline:
        if chain_id() == CHAIN_ID:
            print(f"anchor stand-in running: {RPC}, chain {CHAIN_ID}, pid {proc.pid}, state {STATE.relative_to(ROOT)}")
            return
        time.sleep(0.3)
    sys.exit(f"Anvil did not answer within 30 s; see {LOG_FILE.relative_to(ROOT)}")


def cmd_stop(_args):
    if not PID_FILE.exists():
        print("not running (no pid file)")
        return
    pid = int(PID_FILE.read_text())
    if os.name == "nt":
        subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
    else:
        try:
            os.kill(pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    PID_FILE.unlink()
    deadline = time.time() + 20
    while chain_id() is not None and time.time() < deadline:
        time.sleep(0.3)
    print("anchor stand-in stopped" if chain_id() is None else "still answering after 20 s")


def deployment():
    if not BROADCAST.exists():
        return None
    run = json.loads(BROADCAST.read_text())
    return run.get("returns", {}).get("anchor", {}).get("value")


def cmd_status(_args):
    cid = chain_id()
    if cid is None:
        print(f"anchor stand-in: not running ({RPC})")
        return
    print(f"anchor stand-in: chain {cid}, height {int(rpc('eth_blockNumber'), 16)}, {RPC}")
    address = deployment()
    if not address:
        print("StateAnchor: not deployed (python chain/anchor.py deploy)")
        return
    code = rpc("eth_getCode", [address, "latest"])
    if code in ("0x", "0x0"):
        print(f"StateAnchor {address}: NO CODE (state lost? redeploy and reset the anchor records of the old address)")
        return
    # StateAnchor.lastAnchoredBlock() = 0x38e36544
    last = int(rpc("eth_call", [{"to": address, "data": "0x38e36544"}, "latest"]) or "0x0", 16)
    print(f"StateAnchor {address}: last anchored private block {last}")


def anchorer_address(args):
    for a in args:
        if a.startswith("--anchorer="):
            return a.split("=", 1)[1]
    if not KEYSTORE.exists():
        sys.exit("No anchor key yet: run `cd backend && npm run anchor:setup` (or pass --anchorer=0x...).")
    return json.loads(KEYSTORE.read_text())["address"]


def cmd_deploy(args):
    require_stand_in()
    accounts = rpc("eth_accounts")
    deployer, owner = accounts[0], accounts[1]
    anchorer = anchorer_address(args)
    env = dict(os.environ)
    env.update({"DEPLOYER": deployer, "ANCHOR_OWNER": owner, "ANCHORER": anchorer, "LOCAL_DEV_NETWORK": "true"})
    # Anvil signs for its own unlocked dev accounts: no private key is passed or printed.
    r = subprocess.run(
        [foundry("forge"), "script", "script/DeployAnchor.s.sol", "--rpc-url", RPC, "--broadcast",
         "--unlocked", "--sender", deployer],
        cwd=CONTRACTS, env=env, capture_output=True, text=True,
    )
    if r.returncode != 0 or "ONCHAIN EXECUTION COMPLETE & SUCCESSFUL" not in r.stdout:
        sys.exit("deploy failed:\n" + (r.stdout[-2000:] + r.stderr[-2000:]))
    address = deployment()
    rpc("anvil_setBalance", [anchorer, hex(10 * 10**18)])
    print(f"StateAnchor {address} (owner {owner}, anchor key {anchorer}); post-deploy check passed")
    print(f"broadcast: {BROADCAST.relative_to(ROOT)}")


def cmd_reset(_args):
    cmd_stop([])
    if DATA.exists():
        shutil.rmtree(DATA)
    print("anchor stand-in state deleted. Anchor records in the database still point at the old contract:"
          " use a fresh database or keep them as history.")


COMMANDS = {"start": cmd_start, "stop": cmd_stop, "status": cmd_status, "deploy": cmd_deploy, "reset": cmd_reset}

if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        sys.exit("usage: python chain/anchor.py start|stop|status|deploy [--anchorer=0x...]|reset")
    COMMANDS[sys.argv[1]](sys.argv[2:])
