import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  http,
  type Abi,
  type Account,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
  keccak256,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { withSignerLock } from "./db";

/**
 * DEMO SIGNER — local prototype only.
 *
 * Signs platform transactions with the generated local dev keys in chain/network/dev-accounts.env.
 * It refuses to run in production builds and on any chain other than the local dev chain. In the
 * real system, Step 5d's signing service (HSM/MPC, policy engine, maker-checker) replaces it.
 */
export const LOCAL_CHAIN_ID = 586_586;
const RPC_URL = process.env.CHAIN_RPC_URL ?? "http://127.0.0.1:8545";
const REPO_ROOT = join(process.cwd(), "..");

export const localChain = defineChain({
  id: LOCAL_CHAIN_ID,
  name: "Local Besu (dev)",
  nativeCurrency: { name: "Dev", symbol: "DEV", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});

// Blocks come every 2 s; poll receipts every 250 ms instead of viem's 4 s default.
export const publicClient = createPublicClient({ chain: localChain, transport: http(RPC_URL, { timeout: 5_000 }), pollingInterval: 250 });

export type PlatformRole = "IDENTITY_OPERATOR" | "CLAIM_SIGNER" | "REGISTRAR" | "ISSUANCE_SAFE" | "OPS_SAFE";
export type Persona = "ALICE" | "BOB";

function guard(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("The demo signer is disabled in production builds.");
  }
}

function devKey(name: PlatformRole | Persona): Hex {
  guard();
  const file = join(REPO_ROOT, "chain", "network", "dev-accounts.env");
  // Fixed path inside the repository.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (!existsSync(file)) throw new Error("Local dev accounts not found. Run `python chain/net.py setup`.");
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.startsWith(`${name}_KEY=`)) return line.slice(name.length + 5) as Hex;
  }
  throw new Error(`No local dev key for ${name}`);
}

export function platformAccount(role: PlatformRole): Account {
  return privateKeyToAccount(devKey(role));
}

export function personaAccount(persona: Persona): Account {
  return privateKeyToAccount(devKey(persona));
}

/** Checks the RPC endpoint really is the local dev chain before any key is used. */
export async function assertLocalChain(): Promise<void> {
  guard();
  const id = await publicClient.getChainId();
  if (id !== LOCAL_CHAIN_ID) throw new Error(`Refusing to sign: chain ${id} is not the local dev chain`);
}

/** The call was refused before anything was broadcast (failed chain check or simulation): it can never execute. */
export class NotSentError extends Error {}

/** The transaction was mined and reverted: final, it will never execute. */
export class RevertedError extends Error {}

/** A signed transaction, known before it is broadcast. */
export interface Signed {
  hash: Hex;
  nonce: number;
  from: Address;
}

/**
 * Simulates a contract call, then signs it and broadcasts it with zero gas price (private chain).
 *
 * - Throws NotSentError when it is refused before anything leaves this process.
 * - Calls `onSigned` with the transaction hash and nonce BEFORE broadcasting, so callers can record
 *   them durably; then any later failure is resolvable from the chain (receipt or dropped nonce).
 * - Holds a per-signer lock (all processes) from nonce selection until the node has the
 *   transaction, so concurrent senders never reuse a nonce.
 * Any error after `onSigned` means the outcome is unknown.
 */
export async function send<
  const abi extends Abi,
  name extends ContractFunctionName<abi, "nonpayable" | "payable">,
>(
  account: Account,
  call: { address: Address; abi: abi; functionName: name; args: ContractFunctionArgs<abi, "nonpayable" | "payable", name> },
  onSigned?: (s: Signed) => Promise<void>,
): Promise<Hex> {
  if (!account.signTransaction) throw new NotSentError("account cannot sign locally");
  const signTransaction = account.signTransaction.bind(account);
  try {
    await assertLocalChain();
    await publicClient.simulateContract({ ...call, account } as never);
  } catch (e) {
    throw new NotSentError(e instanceof Error ? e.message : String(e));
  }
  const data = encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args } as never);
  return withSignerLock(account.address, async () => {
    let serialized: Hex;
    let signed: Signed;
    try {
      const nonce = await publicClient.getTransactionCount({ address: account.address, blockTag: "pending" });
      const gas = await publicClient.estimateGas({ account, to: call.address, data });
      serialized = await signTransaction({
        type: "legacy",
        chainId: LOCAL_CHAIN_ID,
        nonce,
        to: call.address,
        data,
        gas: (gas * 12n) / 10n,
        gasPrice: 0n,
      });
      signed = { hash: keccak256(serialized), nonce, from: account.address };
    } catch (e) {
      throw new NotSentError(e instanceof Error ? e.message : String(e));
    }
    if (onSigned) {
      try {
        await onSigned(signed);
      } catch (e) {
        // Could not record it, so it must not be sent.
        throw new NotSentError(e instanceof Error ? e.message : String(e));
      }
    }
    return publicClient.sendRawTransaction({ serializedTransaction: serialized });
  });
}

/** Waits for a receipt; throws RevertedError on a revert, or a plain error on timeout (outcome unknown). */
export async function waitSuccess(hash: Hex): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== "success") throw new RevertedError(`Transaction reverted: ${hash}`);
}

export type TxOutcome = "success" | "reverted" | "dropped" | "pending" | "unknown";

/**
 * What became of a signed transaction:
 * - "success" / "reverted": it has a receipt.
 * - "dropped": no receipt, and the sender's mined nonce is already past it, so another
 *   transaction used that nonce and this one can never be mined.
 * - "pending": the node still holds it.
 * - "unknown": neither (e.g. signed but never delivered); it resolves to "dropped" once the
 *   signer's next transaction takes the nonce. Also returned on any RPC error.
 */
export async function txOutcome(hash: Hex, from: Address, nonce: number): Promise<TxOutcome> {
  try {
    const receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null);
    if (receipt) return receipt.status === "success" ? "success" : "reverted";
    const mined = await publicClient.getTransactionCount({ address: from, blockTag: "latest" });
    if (mined > nonce) return "dropped";
    const inPool = await publicClient.getTransaction({ hash }).catch(() => null);
    return inPool ? "pending" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Sends a contract call and waits for a successful receipt. */
export async function sendAndWait<
  const abi extends Abi,
  name extends ContractFunctionName<abi, "nonpayable" | "payable">,
>(
  account: Account,
  call: { address: Address; abi: abi; functionName: name; args: ContractFunctionArgs<abi, "nonpayable" | "payable", name> },
): Promise<Hex> {
  const hash = await send(account, call);
  await waitSuccess(hash);
  return hash;
}
