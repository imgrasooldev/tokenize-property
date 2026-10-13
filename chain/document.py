"""Records document hashes in the DocumentRegistry on the local network (S-07 verification demo).

  python chain/document.py add FILE [--type N] [--uri pt-doc://ID]
      SHA-256 of FILE; the Ops Safe adds (token, type, hash, uri). Idempotent: if a record of the live
      token already has this hash, it is reused and nothing is sent. Prints one JSON line.
  python chain/document.py supersede OLD_ID NEW_ID
      The Ops Safe marks OLD_ID as superseded by NEW_ID. Idempotent for the same pair.
  python chain/document.py list

Only the hash and the reference go on chain, never the file. Type numbers follow
DocumentRegistry.DocType: 0 TitleDeed, 1 LandRecord, 2 Valuation, 3 Insurance, 4 TrustDeed,
5 AuditReport, 6 ShariahCertificate, 7 CourtOrder, 8 InvestorVote, 9 Other (default).

LOCAL DEVELOPMENT ONLY: uses the local Ops Safe dev key, like rent.py, and refuses any chain but the
local one. Production adds documents through the outbox and the signing service (a `document.add`
kind, S-01; not built yet).
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

CHAIN = Path(__file__).resolve().parent
sys.path.insert(0, str(CHAIN))
import flow  # noqa: E402
import net  # noqa: E402

NAMES = ["timelock", "oidAuthority", "trexAuthority", "idFactory", "factory", "claimIssuer", "countryModule",
         "maxBalanceModule", "token", "ir", "issuance", "pauseGuard", "freezeGuard", "recovery",
         "registrarGuard", "distributions", "documents"]
DOC = re.compile(r'^\((0x[0-9a-fA-F]{40}), (\d+), (\d+)(?: \[[^\]]*\])?, (0x[0-9a-f]{64}), (\d+)(?: \[[^\]]*\])?, "(.*)"\)$')
URI = re.compile(r"^pt-doc://[A-Za-z0-9._-]{1,200}$")


def deployment():
    run = json.loads((flow.CONTRACTS / "broadcast" / "Deploy.s.sol" / str(net.CHAIN_ID) / "run-latest.json").read_text())
    values = flow.re.findall(r"0x[0-9a-fA-F]{40}", run["returns"]["d"]["value"])
    if len(values) != len(NAMES):
        sys.exit("No complete deployment found; run chain/flow.py first.")
    return dict(zip(NAMES, values))


def local_only():
    r = flow.cast("chain-id")
    if r.returncode != 0 or r.stdout.strip() != str(net.CHAIN_ID):
        sys.exit(f"Refusing: the RPC is not the local dev chain {net.CHAIN_ID}.")


def documents(d):
    """All records of the registry: {id: (token, type, sha256, superseded_by, uri)}."""
    count = int(flow.call(d["documents"], "documentCount()(uint256)"))
    out = {}
    for i in range(1, count + 1):
        r = flow.cast("call", d["documents"], "getDocument(uint256)((address,uint8,uint64,bytes32,uint256,string))", str(i))
        m = DOC.match(r.stdout.strip())
        if r.returncode != 0 or not m:
            sys.exit(f"Could not read document {i}: {(r.stderr or r.stdout).strip()[:200]}")
        out[i] = (m.group(1).lower(), int(m.group(2)), m.group(4), int(m.group(5)), m.group(6))
    return out


def add(args):
    d = deployment()
    data = Path(args.file).read_bytes()
    sha = "0x" + hashlib.sha256(data).hexdigest()
    uri = args.uri or f"pt-doc://sha256-{sha[2:18]}"
    if not URI.match(uri):
        sys.exit("uri must look like pt-doc://<id> (letters, digits, . _ -)")
    if not 0 <= args.type <= 9:
        sys.exit("type must be 0..9")
    token = d["token"].lower()
    for i, (t, _ty, h, _sup, _u) in documents(d).items():
        if t == token and h == sha:
            print(json.dumps({"id": i, "sha256": sha, "existing": True}))
            return
    ok, _, err = flow.send("OPS_SAFE", d["documents"], "add(address,uint8,bytes32,string)", d["token"], args.type, sha, uri)
    if not ok:
        sys.exit(f"add failed: {err}")
    new_id = max(i for i, v in documents(d).items() if v[0] == token and v[2] == sha)
    print(json.dumps({"id": new_id, "sha256": sha, "existing": False}))


def supersede(args):
    d = deployment()
    docs = documents(d)
    old, new = docs.get(args.old), docs.get(args.new)
    if not old or not new:
        sys.exit("unknown document id")
    if old[3] == args.new:
        print(json.dumps({"old": args.old, "new": args.new, "existing": True}))
        return
    ok, _, err = flow.send("OPS_SAFE", d["documents"], "supersede(uint256,uint256)", args.old, args.new)
    if not ok:
        sys.exit(f"supersede failed: {err}")
    print(json.dumps({"old": args.old, "new": args.new, "existing": False}))


def list_docs(_args):
    for i, (t, ty, h, sup, uri) in documents(deployment()).items():
        print(f"#{i} token {t} type {ty} sha256 {h} superseded_by {sup or '-'} {uri}")


def main():
    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("add")
    a.add_argument("file")
    a.add_argument("--type", type=int, default=9)
    a.add_argument("--uri")
    s = sub.add_parser("supersede")
    s.add_argument("old", type=int)
    s.add_argument("new", type=int)
    sub.add_parser("list")
    args = p.parse_args()
    local_only()
    {"add": add, "supersede": supersede, "list": list_docs}[args.cmd](args)


if __name__ == "__main__":
    main()
