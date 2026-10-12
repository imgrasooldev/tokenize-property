import { fileURLToPath } from "node:url";
import { LOCAL_DEV_CHAIN_ID, readEnvFile } from "@pt/config";
import { issuanceGuardAbi } from "@pt/contracts";
import pg from "pg";
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  encodeFunctionData,
  http,
  keccak256,
  type Address,
  type PublicClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { z } from "zod";
import { RefusedError, TransientError, type Command, type Executor, type Outcome, type Signed } from "./index.ts";

/**
 * LOCAL DEVELOPMENT EXECUTOR for the outbox: signs with a generated dev key from
 * chain/network/dev-accounts.env on the local chain (586586) only, and refuses production. Step 5d's
 * signing service (HSM/MPC, policy engine, maker-checker) replaces it.
 */

const DEV_ACCOUNTS = fileURLToPath(new URL("../../../../chain/network/dev-accounts.env", import.meta.url));
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES32 = /^0x[0-9a-fA-F]{64}$/;

export const mintPayload = z.object({
  issuance: z.string().regex(ADDRESS),
  to: z.string().regex(ADDRESS),
  amount: z.string().regex(/^[1-9][0-9]{0,17}$/),
  refId: z.string().regex(BYTES32),
});
export type MintPayload = z.infer<typeof mintPayload>;

/** Serialises nonce selection per signing address across processes (same lock as the website). */
export type SignerLock = <T>(address: string, fn: () => Promise<T>) => Promise<T>;

export function pgSignerLock(settings: pg.PoolConfig): SignerLock {
  const pool = new pg.Pool({ ...settings, database: "postgres", max: 4, application_name: "outbox-signer-lock" });
  return async (address, fn) => {
    const client = await pool.connect();
    try {
      await client.query("SELECT pg_advisory_lock($1, hashtext($2))", [586_586_040, address.toLowerCase()]);
      try {
        return await fn();
      } finally {
        await client.query("SELECT pg_advisory_unlock($1, hashtext($2))", [586_586_040, address.toLowerCase()]);
      }
    } finally {
      client.release();
    }
  };
}

function devAccount(role: string): PrivateKeyAccount {
  if (process.env.NODE_ENV === "production") throw new Error("The local executor is disabled in production.");
  if (!/^[A-Z_]{3,40}$/.test(role)) throw new Error("invalid role name");
  const key = readEnvFile(DEV_ACCOUNTS)[`${role}_KEY`];
  if (!key || !BYTES32.test(key)) throw new Error(`No local dev key for ${role}. Run \`python chain/net.py setup\`.`);
  return privateKeyToAccount(key as `0x${string}`);
}

function isRevert(e: unknown): boolean {
  return e instanceof BaseError && e.walk((x) => x instanceof ContractFunctionRevertedError) !== null;
}

/** Executes `issuance.mint` commands through IssuanceGuard.mint as the local Issuance Safe. */
export function localMintExecutor(opts: { rpcUrl?: string; lock: SignerLock; role?: string }): Executor {
  const account = devAccount(opts.role ?? "ISSUANCE_SAFE");
  const client: PublicClient = createPublicClient({ transport: http(opts.rpcUrl ?? "http://127.0.0.1:8545", { timeout: 10_000 }), pollingInterval: 250 });

  return {
    async submit(cmd: Command, record) {
      if (process.env.NODE_ENV === "production") throw new RefusedError("local executor disabled in production");
      const parsed = mintPayload.safeParse(cmd.payload);
      if (!parsed.success) throw new RefusedError(`invalid mint payload: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
      const p = parsed.data;
      const call = {
        address: p.issuance as Address,
        abi: issuanceGuardAbi,
        functionName: "mint",
        args: [p.to as Address, BigInt(p.amount), p.refId as `0x${string}`],
      } as const;
      try {
        if ((await client.getChainId()) !== LOCAL_DEV_CHAIN_ID) throw new RefusedError("not the local dev chain");
        await client.simulateContract({ ...call, account });
      } catch (e) {
        if (e instanceof RefusedError) throw e;
        if (isRevert(e)) throw new RefusedError(e instanceof Error ? e.message.split("\n")[0] ?? "reverted" : "reverted");
        throw new TransientError(e instanceof Error ? e.message.split("\n")[0] ?? "rpc error" : "rpc error");
      }
      const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args });
      return opts.lock(account.address, async () => {
        let serialized: `0x${string}`;
        let signed: Signed;
        try {
          const nonce = await client.getTransactionCount({ address: account.address, blockTag: "pending" });
          const gas = await client.estimateGas({ account, to: call.address, data });
          serialized = await account.signTransaction({
            type: "legacy",
            chainId: LOCAL_DEV_CHAIN_ID,
            nonce,
            to: call.address,
            data,
            gas: (gas * 12n) / 10n,
            gasPrice: 0n,
          });
          signed = { hash: keccak256(serialized), nonce: BigInt(nonce), from: account.address.toLowerCase() as `0x${string}` };
        } catch (e) {
          throw new TransientError(e instanceof Error ? e.message.split("\n")[0] ?? "signing failed" : "signing failed");
        }
        if (!(await record(signed))) return null; // lease lost: must not broadcast
        await client.sendRawTransaction({ serializedTransaction: serialized });
        return signed;
      });
    },

    async wait(signed, timeoutMs) {
      try {
        const r = await client.waitForTransactionReceipt({ hash: signed.hash, timeout: timeoutMs });
        return r.status === "success" ? "success" : "reverted";
      } catch {
        return "pending";
      }
    },

    async outcome(signed): Promise<Outcome> {
      try {
        const receipt = await client.getTransactionReceipt({ hash: signed.hash }).catch(() => null);
        if (receipt) return receipt.status === "success" ? "success" : "reverted";
        const mined = await client.getTransactionCount({ address: signed.from, blockTag: "latest" });
        if (BigInt(mined) > signed.nonce) return "dropped";
        const inPool = await client.getTransaction({ hash: signed.hash }).catch(() => null);
        return inPool ? "pending" : "unknown";
      } catch {
        return "unknown";
      }
    },
  };
}
