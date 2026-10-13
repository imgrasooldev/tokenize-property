import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Address, Hex } from "viem";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { distributionRegistryAbi, documentRegistryAbi, issuanceGuardAbi, tokenAbi } from "../src/lib/abis";
import { verifyEntitlementProof } from "../src/lib/merkle";
import { anchorSection } from "../src/lib/server/anchors";
import { latestDeployment, publicClient } from "../src/lib/server/chain";
import { verifyProofOnChain } from "../src/lib/server/rent";
import { latestReconciliation, verificationView } from "../src/lib/server/verify";
import { asAdmin } from "./helpers";
import { chainUp, prepare, start, type Stack } from "./stack";

/**
 * S-07 public verification page against the real local chain and the TEST database: every figure
 * the page shows equals the contract views at the same block (T-027), the website's own role sees
 * no anchor or reconciliation records it has no grant for (shown as such, never guessed), the
 * on-chain proof check accepts a real entitlement and refuses 1 paisa more, and the view carries
 * no holder wallet. Skipped without a chain (CI).
 */
const up = await chainUp();
if (up) prepare();

let stack: Stack | undefined;

describe.skipIf(!up)("public verification view (read model vs chain)", () => {
  beforeAll(async () => {
    stack = await start();
  });
  afterAll(async () => {
    await stack?.stop();
  });

  it("shows anchor and reconciliation records as not readable while the website's role has no grant", async () => {
    const before = process.env.ANCHOR_CONTRACT;
    process.env.ANCHOR_CONTRACT = "0x00000000000000000000000000000000000a0c40";
    try {
      const a = await anchorSection();
      expect(a.state).toBe("no-access");
    } finally {
      if (before === undefined) delete process.env.ANCHOR_CONTRACT;
      else process.env.ANCHOR_CONTRACT = before;
    }
    expect((await latestReconciliation()).state).toBe("no-access");
  });

  it("supply, cap, pause, holders, documents and distributions equal the contracts at the read model's block", async () => {
    const v = await verificationView();
    expect(["ok", "stale"]).toContain(v.index.gate);
    const block = BigInt(v.index.block ?? "-1");
    expect(block).toBeGreaterThan(0n);
    expect(v.index.blockTime).not.toBeNull();
    const d = latestDeployment();
    const token = d?.get("token");
    const issuance = d?.get("issuance");
    const documents = d?.get("documents");
    const distributions = d?.get("distributions");
    if (!token || !issuance || !documents || !distributions) throw new Error("no deployment");
    const at = { blockNumber: block };

    const t = v.token;
    if (!t) throw new Error("no token in the view");
    expect(t.address).toBe(token);
    expect(BigInt(t.supply)).toBe(await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "totalSupply", ...at }));
    expect(BigInt(t.cap)).toBe(await publicClient.readContract({ address: issuance, abi: issuanceGuardAbi, functionName: "trusteeCap", ...at }));
    expect(t.paused).toBe(await publicClient.readContract({ address: token, abi: tokenAbi, functionName: "paused", ...at }));
    // No attestation is published yet: never green (PV-2).
    expect(t.register).toEqual({ kind: "not-published" });

    const holders = await asAdmin<{ holder: string }>("SELECT holder FROM chain.holdings WHERE token = $1 AND balance > 0", [token]);
    expect(t.holders).toBe(holders.length);

    const docs = v.documents ?? [];
    const count = await publicClient.readContract({ address: documents, abi: documentRegistryAbi, functionName: "documentCount", ...at });
    expect(BigInt(docs.length)).toBe(count); // the local network has one token
    for (const x of docs) {
      const onChain = await publicClient.readContract({ address: documents, abi: documentRegistryAbi, functionName: "getDocument", args: [BigInt(x.id)], ...at });
      expect(x.sha256).toBe(onChain.sha256Hash.toLowerCase());
      expect(x.uri).toBe(onChain.uri);
      expect(x.supersededBy).toBe(onChain.supersededBy === 0n ? null : onChain.supersededBy.toString());
    }

    const dists = v.distributions ?? [];
    expect(dists.length).toBeGreaterThan(0); // flow.py publishes one
    const statusName = ["none", "published", "rejected", "finalized", "paid"];
    for (const x of dists) {
      const onChain = await publicClient.readContract({ address: distributions, abi: distributionRegistryAbi, functionName: "getDistribution", args: [BigInt(x.id)], ...at });
      expect(x.root).toBe(onChain.merkleRoot.toLowerCase());
      expect(BigInt(x.totalPaisa)).toBe(onChain.totalPaisa);
      expect(x.statementHash).toBe(onChain.statementHash.toLowerCase());
      expect(BigInt(x.recordBlock)).toBe(onChain.recordBlock);
      expect(x.status).toBe(statusName.at(onChain.status));
    }

    // Privacy (PV-3, acceptance 5): no holder wallet, investor name or contact anywhere in the view.
    const json = JSON.stringify(v).toLowerCase();
    for (const h of holders) expect(json).not.toContain(h.holder.slice(2));
    const names = await asAdmin<{ display_name: string }>("SELECT display_name FROM webdemo.investors LIMIT 200");
    for (const n of names) expect(json).not.toContain(n.display_name.toLowerCase());
    expect(json).not.toMatch(/cnic|phone|display_name|kyc_subject/);
  });

  it("verifies a published entitlement on chain at the pinned block and refuses 1 paisa more", async (ctx) => {
    const v = await verificationView();
    const token = latestDeployment()?.get("token");
    const dir = join(import.meta.dirname, "..", "..", "chain", "data", "rent");
    // Statements are written by chain/rent.py into a git-ignored folder; skip when none exists here.
    const files = token && existsSync(dir) ? readdirSync(dir).filter((f) => f.startsWith(`${token}-`) && f.endsWith(".json")) : [];
    const file = files.at(-1);
    if (!file) {
      ctx.skip();
      return;
    }
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const s = JSON.parse(readFileSync(join(dir, file), "utf8")) as { id: number; root: Hex; entitlements: { wallet: Address; amountPaisa: number; proof: Hex[] }[] };
    const e = s.entitlements.at(0);
    if (!e) throw new Error("empty statement");
    const block = BigInt(v.index.block ?? "0");
    const pub = v.distributions?.find((x) => x.id === String(s.id));
    expect(pub?.root).toBe(s.root);
    expect(verifyEntitlementProof(s.root, e.wallet, BigInt(e.amountPaisa), e.proof)).toBe(true);
    expect(await verifyProofOnChain(BigInt(s.id), e.wallet, BigInt(e.amountPaisa), e.proof, block)).toEqual({ valid: true, controlRejected: true });
    expect(await verifyProofOnChain(BigInt(s.id), e.wallet, BigInt(e.amountPaisa) + 1n, e.proof, block)).toEqual({ valid: false, controlRejected: true });
  });
});
