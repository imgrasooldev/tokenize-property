import { randomInt, randomUUID } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type pg from "pg";
import type { Address } from "viem";
import { tokenAbi } from "../src/lib/abis";
import { latestDeployment, publicClient } from "../src/lib/server/chain";
import { investorById, tx, type InvestorRow } from "../src/lib/server/db";
import { followOnce } from "../src/lib/server/follower";
import { startOnboarding } from "../src/lib/server/onboarding";
import { createCustodialWallet, kycOnboard } from "../src/lib/server/services";
import { adminDb } from "./stack";

/** Runs the settlement follower until `done` holds (the outbox worker and indexer run as processes). */
export async function until(what: string, done: () => Promise<boolean>, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  for (;;) {
    await followOnce();
    if (await done()) return;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}

/** A CNIC the mock NADRA accepts (last digit 1-7; 0, 8 and 9 simulate failures). */
export function randomCnic(): string {
  const d = (n: number) => Array.from({ length: n }, () => String(randomInt(0, 10))).join("");
  return `${d(5)}-${d(7)}-${String(randomInt(1, 8))}`;
}

/**
 * A fresh investor onboarded exactly like a web sign-up: custodial wallet from the signing service,
 * KYC by the KYC service, then identity, claims and registration through the outbox and the signer.
 */
export async function onboardInvestor(name: string): Promise<InvestorRow> {
  const wallet = await createCustodialWallet();
  const kyc = await kycOnboard({ cnic: randomCnic(), fullName: name, livenessSessionId: `test-${randomUUID()}`, wallet });
  if (!kyc.ok || kyc.status !== "verified") throw new Error(`KYC did not verify the test investor: ${JSON.stringify(kyc)}`);
  const id = await tx(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      "INSERT INTO webdemo.investors (display_name, wallet_address, kyc_status, kyc_subject) VALUES ($1, $2, 'pending', $3) RETURNING id",
      [name, wallet, kyc.subjectId],
    );
    const newId = rows[0]?.id ?? "";
    await startOnboarding(c, newId, wallet);
    return newId;
  });
  await until(`onboarding of ${name}`, async () => (await investorById(id))?.kyc_status === "verified", 150_000);
  const row = await investorById(id);
  if (!row) throw new Error("investor missing");
  return row;
}

/** balanceOf on chain (the tests check the chain itself, not only the read model). */
export async function chainBalance(wallet: Address): Promise<bigint> {
  const token = latestDeployment()?.get("token");
  if (!token) throw new Error("no token");
  return publicClient.readContract({ address: token, abi: tokenAbi, functionName: "balanceOf", args: [wallet] });
}

/** SQL as the database admin on the TEST database (test set-up and operator actions only). */
export async function asAdmin<T extends object>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = adminDb();
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/** The signing request of an outbox command, once the worker has asked for it. */
export async function signerRequestFor(commandKey: string): Promise<{ id: string; status: string } | null> {
  const rows = await asAdmin<{ id: string; status: string }>("SELECT id, status FROM signer.requests WHERE command_ref = $1", [commandKey]);
  return rows[0] ?? null;
}

/**
 * Step 6d (migration 0023): a mint above the approval threshold also needs the trustee's
 * co-signature. Given as the trustee portal gives it (officer session, one-time ticket), through
 * the backend's test helper; the officer is created on the TEST database once and reused.
 */
export async function trusteeCosign(requestId: string): Promise<string> {
  const url = pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "packages", "db", "test", "officers.ts")).href;
  const m = (await import(/* @vite-ignore */ url)) as { trusteeCosign: (db: pg.ClientBase, id: string) => Promise<string> };
  const c = adminDb();
  await c.connect();
  try {
    return await m.trusteeCosign(c, requestId);
  } finally {
    await c.end();
  }
}
