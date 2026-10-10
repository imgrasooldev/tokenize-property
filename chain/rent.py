"""Publishes a monthly rent distribution on the local network (investor website W3 demo).

What it does, with real blocks:
  1. Measures every holder's balance at a past block (record block) from the token's Transfer logs.
  2. Splits the rent pro rata in exact paisa (largest remainder, so the parts sum to the whole).
  3. Builds the Merkle tree in the DistributionRegistry leaf format
     keccak256(bytes.concat(keccak256(abi.encode(account, amountPaisa)))), sorted-pair hashing.
  4. Ops Safe publishes the root, the total and the hash of the rent statement.
  5. Checks every proof on chain (and that a wrong amount fails), then writes the statement with
     proofs to chain/data/rent/ (git-ignored), where the investor website reads it.

Usage (network running, flow.py already run):  python chain/rent.py [rupees]   (default 300000)
LOCAL DEVELOPMENT ONLY: uses the local Ops Safe dev key.
"""

import json
import sys
from pathlib import Path

CHAIN = Path(__file__).resolve().parent
sys.path.insert(0, str(CHAIN))
import flow  # noqa: E402
import net  # noqa: E402

OUT = CHAIN / "data" / "rent"
TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef"


def keccak(hex_data):
    r = flow.cast("keccak", hex_data)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()


def leaf(account, amount):
    encoded = flow.cast("abi-encode", "f(address,uint256)", account, str(amount)).stdout.strip()
    return keccak(keccak(encoded))


def hash_pair(a, b):
    lo, hi = sorted([a, b], key=lambda x: int(x, 16))
    return keccak(lo + hi[2:])


def build_tree(leaves):
    """Returns (root, proofs) for the given leaf hashes; proofs[i] belongs to leaves[i]."""
    proofs = [[] for _ in leaves]
    level = [(h, [i]) for i, h in enumerate(leaves)]  # (hash, indices of leaves under this node)
    while len(level) > 1:
        nxt = []
        for k in range(0, len(level) - 1, 2):
            (ha, ia), (hb, ib) = level[k], level[k + 1]
            for i in ia:
                proofs[i].append(hb)
            for i in ib:
                proofs[i].append(ha)
            nxt.append((hash_pair(ha, hb), ia + ib))
        if len(level) % 2:
            nxt.append(level[-1])  # odd node moves up unchanged
        level = nxt
    return level[0][0], proofs


def process_proof(h, proof):
    for p in proof:
        h = hash_pair(h, p)
    return h


def holders(token, to_block):
    logs = net.rpc(net.RPC_BASE, "eth_getLogs",
                   [{"address": token, "fromBlock": "0x0", "toBlock": hex(to_block), "topics": [TRANSFER]}], timeout=30)
    seen = []
    for log in logs:
        addr = "0x" + log["topics"][2][-40:]
        if int(addr, 16) != 0 and addr.lower() not in seen:
            seen.append(addr.lower())
    return seen


def main():
    rupees = int(sys.argv[1]) if len(sys.argv) > 1 else 300_000
    if not 1 <= rupees <= 10_000_000:
        sys.exit("rent must be between Rs 1 and Rs 10,000,000")
    total = rupees * 100
    run = json.loads((flow.CONTRACTS / "broadcast" / "Deploy.s.sol" / str(net.CHAIN_ID) / "run-latest.json").read_text())
    names = ["timelock", "oidAuthority", "trexAuthority", "idFactory", "factory", "claimIssuer", "countryModule",
             "maxBalanceModule", "token", "ir", "issuance", "pauseGuard", "freezeGuard", "recovery",
             "registrarGuard", "distributions", "documents"]
    values = flow.re.findall(r"0x[0-9a-fA-F]{40}", run["returns"]["d"]["value"])
    if len(values) != len(names):
        sys.exit("No complete deployment found; run chain/flow.py first.")
    d = dict(zip(names, values))

    record = int(flow.cast("block-number").stdout.strip()) - 1
    balances = {}
    for h in holders(d["token"], record):
        bal = int(flow.call(d["token"], "balanceOf(address)(uint256)", h, "--block", record))
        if bal > 0:
            balances[h] = bal
    supply = sum(balances.values())
    if supply == 0:
        sys.exit("No tokens held at the record block.")

    # Largest remainder: exact paisa, parts always sum to the total.
    shares = {a: total * b // supply for a, b in balances.items()}
    left = total - sum(shares.values())
    for a in sorted(balances, key=lambda x: (-(total * balances[x] % supply), x))[:left]:
        shares[a] += 1
    assert sum(shares.values()) == total

    entitlements = [{"wallet": a, "amountPaisa": shares[a], "tokens": balances[a]} for a in sorted(shares)]
    statement = {"token": d["token"].lower(), "recordBlock": record, "totalPaisa": total, "entitlements": entitlements}
    canonical = json.dumps(statement, sort_keys=True, separators=(",", ":"))
    statement_hash = keccak("0x" + canonical.encode().hex())

    leaves = [leaf(e["wallet"], e["amountPaisa"]) for e in entitlements]
    root, proofs = build_tree(leaves)
    for lf, pr in zip(leaves, proofs):
        assert process_proof(lf, pr) == root, "local proof check failed"

    print(f"Record block {record}: {len(entitlements)} holders, {supply} tokens, rent Rs {rupees:,}")
    flow.must_send("OPS_SAFE", d["distributions"], "publish(address,uint64,bytes32,uint256,bytes32)",
                   d["token"], record, root, total, statement_hash,
                   label="Ops Safe publishes the Merkle root, total and statement hash")
    dist_id = int(flow.call(d["distributions"], "distributionCount()(uint256)"))
    for e, pr in zip(entitlements, proofs):
        arr = "[" + ",".join(pr) + "]"
        flow.check(flow.call(d["distributions"], "verify(uint256,address,uint256,bytes32[])(bool)",
                             dist_id, e["wallet"], e["amountPaisa"], arr) == "true",
                   f"{e['wallet'][:10]}… Rs {e['amountPaisa'] / 100:,.2f} verifies on chain")
        e["proof"] = pr
    first = entitlements[0]
    flow.check(flow.call(d["distributions"], "verify(uint256,address,uint256,bytes32[])(bool)",
                         dist_id, first["wallet"], first["amountPaisa"] + 1, "[" + ",".join(first["proof"]) + "]")
               == "false", "a wrong amount does not verify")

    OUT.mkdir(parents=True, exist_ok=True)
    out = {"id": dist_id, "root": root, "statementHash": statement_hash, "statement": canonical, "entitlements": entitlements}
    path = OUT / f"{d['token'].lower()}-{dist_id}.json"
    path.write_text(json.dumps(out, indent=2))
    print(f"Distribution {dist_id} published; statement with proofs in {path.relative_to(flow.ROOT)}")


if __name__ == "__main__":
    main()
