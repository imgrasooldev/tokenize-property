import type pg from "pg";
import type { Address } from "viem";
import { identityOnChain, latestDeployment } from "./chain";
import { db, tx } from "./db";
import { enqueue, type CommandStatus } from "./outbox";
import { registeredIdentity, registeredOnChain } from "./readmodel";

/**
 * On-chain onboarding of a KYC-verified investor through the outbox and the signing service
 * (Step 5h, ADR 0010), the same path the contract tests prove:
 *   identity.create (identity operator) -> identity.add_claim KYC and AML (the investor's custodial
 *   wallet adds claims signed by the claim key) -> identity.register (registrar, RegistrarGuard).
 * The signing service checks every step against the KYC service's verdict (kyc.is_verified), the
 * IdFactory and the claims on chain. The settlement follower moves each investor one step at a time;
 * a step whose command fails is retried with a new command (at most MAX_ATTEMPTS in total), then
 * the sign-up is marked failed for operations. The website signs nothing.
 */
const PAKISTAN = 586;
const TOPICS = [1, 2] as const; // KYC, AML
const MAX_ATTEMPTS = 3;

const ref = (investorId: string) => `web:onboard:${investorId}`;

async function enqueueCreate(c: pg.ClientBase, investorId: string, wallet: Address, attempt: number): Promise<void> {
  const idFactory = latestDeployment()?.get("idFactory");
  if (!idFactory) throw new Error("no local deployment");
  await enqueue(c, `${ref(investorId)}:identity:a${String(attempt)}`, "identity.create", { idFactory, wallet: wallet.toLowerCase(), salt: `web-${investorId}-a${String(attempt)}` }, ref(investorId));
}

/** Called in the sign-up transaction, right after the investor row is written. */
export async function startOnboarding(c: pg.ClientBase, investorId: string, wallet: Address): Promise<void> {
  await enqueueCreate(c, investorId, wallet, 1);
  await c.query("UPDATE webdemo.investors SET onboard_step = 'identity', onboard_attempt = 1 WHERE id = $1", [investorId]);
}

interface Cmd {
  id: string;
  kind: string;
  topic: string | null;
  status: CommandStatus;
  key: string;
  last_error: string | null;
}

interface Pending {
  id: string;
  wallet_address: Address;
  identity_address: Address | null;
  onboard_step: "identity" | "claims" | "register";
  onboard_attempt: number;
}

async function retryOrFail(p: Pending, what: string, again: (c: pg.ClientBase, attempt: number) => Promise<void>, error: string | null): Promise<void> {
  await tx(async (c) => {
    if (p.onboard_attempt >= MAX_ATTEMPTS) {
      await c.query(
        "UPDATE webdemo.investors SET onboard_step = 'failed', kyc_status = 'rejected', kyc_note = $2 WHERE id = $1 AND onboard_step = $3",
        [p.id, `on-chain registration failed at ${what}: ${error ?? "refused"}`.slice(0, 300), p.onboard_step],
      );
      return;
    }
    const moved = await c.query("UPDATE webdemo.investors SET onboard_attempt = onboard_attempt + 1 WHERE id = $1 AND onboard_attempt = $2", [p.id, p.onboard_attempt]);
    if (moved.rowCount === 1) await again(c, p.onboard_attempt + 1);
  });
}

/** One pass over every investor still being onboarded (called by the settlement follower). */
export async function advanceOnboarding(): Promise<void> {
  const pool = await db();
  const { rows } = await pool.query<Pending>(
    "SELECT id, wallet_address, identity_address, onboard_step, onboard_attempt FROM webdemo.investors WHERE onboard_step IN ('identity', 'claims', 'register') ORDER BY created_at LIMIT 100",
  );
  const d = latestDeployment();
  const registrarGuard = d?.get("registrarGuard");
  if (rows.length === 0 || !registrarGuard) return;
  for (const p of rows) {
    const { rows: all } = await pool.query<Cmd>(
      "SELECT id, kind, payload->>'topic' AS topic, status, idempotency_key AS key, last_error FROM outbox.commands WHERE ref = $1 ORDER BY id",
      [ref(p.id)],
    );
    // The newest command of each step decides.
    const newest = (kind: string, topic?: number): Cmd | undefined => all.filter((c) => c.kind === kind && (topic === undefined || c.topic === String(topic))).at(-1);
    const wallet = p.wallet_address.toLowerCase() as Address;

    if (p.onboard_step === "identity") {
      const cmd = newest("identity.create");
      // The chain is the fact: once the IdFactory knows the identity, move on (even after a retry).
      const identity = cmd?.status === "pending" || cmd?.status === "claimed" ? null : await identityOnChain(wallet);
      if (identity) {
        await tx(async (c) => {
          const moved = await c.query("UPDATE webdemo.investors SET identity_address = $2, onboard_step = 'claims' WHERE id = $1 AND onboard_step = 'identity'", [p.id, identity]);
          if (moved.rowCount !== 1) return;
          for (const topic of TOPICS) {
            await enqueue(c, `${ref(p.id)}:claim${String(topic)}:a1`, "identity.add_claim", { wallet, identity, topic }, ref(p.id));
          }
        });
      } else if (cmd?.status === "failed") {
        await retryOrFail(p, "identity", (c, attempt) => enqueueCreate(c, p.id, wallet, attempt), cmd.last_error);
      }
      continue;
    }

    const identity = p.identity_address?.toLowerCase();
    if (!identity) continue;
    if (p.onboard_step === "claims") {
      const claims = TOPICS.map((t) => ({ topic: t, cmd: newest("identity.add_claim", t) }));
      if (claims.every((x) => x.cmd?.status === "confirmed")) {
        await tx(async (c) => {
          const moved = await c.query("UPDATE webdemo.investors SET onboard_step = 'register' WHERE id = $1 AND onboard_step = 'claims'", [p.id]);
          if (moved.rowCount === 1) {
            await enqueue(c, `${ref(p.id)}:register:a1`, "identity.register", { registrarGuard, wallet, identity, country: PAKISTAN }, ref(p.id));
          }
        });
        continue;
      }
      const failed = claims.find((x) => x.cmd?.status === "failed");
      if (failed) {
        await retryOrFail(p, `claim ${String(failed.topic)}`, async (c, attempt) => {
          await enqueue(c, `${ref(p.id)}:claim${String(failed.topic)}:a${String(attempt)}`, "identity.add_claim", { wallet, identity, topic: failed.topic }, ref(p.id));
        }, failed.cmd?.last_error ?? null);
      }
      continue;
    }

    // register
    const cmd = newest("identity.register");
    if (cmd?.status === "confirmed") {
      // Verified for the website only once the read model shows the registration.
      if ((await registeredOnChain(wallet)) === true && (await registeredIdentity(wallet)) === identity) {
        await pool.query(
          "UPDATE webdemo.investors SET kyc_status = 'verified', onboard_step = 'done', kyc_note = 'KYC service verified; registered on chain through the signing service' WHERE id = $1 AND onboard_step = 'register'",
          [p.id],
        );
      }
    } else if (cmd?.status === "failed") {
      await retryOrFail(p, "registration", async (c, attempt) => {
        await enqueue(c, `${ref(p.id)}:register:a${String(attempt)}`, "identity.register", { registrarGuard, wallet, identity, country: PAKISTAN }, ref(p.id));
      }, cmd.last_error);
    }
  }
}

/** Progress of an investor's on-chain registration, for the account page. */
export async function onboardingProgress(investorId: string): Promise<{ done: number; total: number; waiting: boolean }> {
  const { rows } = await (await db()).query<{ kind: string; status: CommandStatus; last_error: string | null }>(
    "SELECT kind, status, last_error FROM outbox.commands WHERE ref = $1 ORDER BY id",
    [ref(investorId)],
  );
  const confirmed = new Set(rows.filter((r) => r.status === "confirmed").map((r) => r.kind));
  const done = ["identity.create", "identity.add_claim", "identity.register"].filter((k) => confirmed.has(k)).length;
  const waiting = rows.some((r) => r.status === "pending" && /awaiting \d+ approvals/.test(r.last_error ?? ""));
  return { done, total: 3, waiting };
}
