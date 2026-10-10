import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Abi,
  type Account,
  type Address,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

export const publicClient = createPublicClient({ chain: localChain, transport: http(RPC_URL, { timeout: 5_000 }) });

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

/** Sends a contract call with zero gas price (private chain) and waits for a successful receipt. */
export async function sendAndWait<
  const abi extends Abi,
  name extends ContractFunctionName<abi, "nonpayable" | "payable">,
>(
  account: Account,
  call: { address: Address; abi: abi; functionName: name; args: ContractFunctionArgs<abi, "nonpayable" | "payable", name> },
): Promise<Hex> {
  await assertLocalChain();
  const wallet = createWalletClient({ account, chain: localChain, transport: http(RPC_URL, { timeout: 10_000 }) });
  const { request } = await publicClient.simulateContract({ ...call, account } as never);
  const hash = await wallet.writeContract({ ...(request as object), type: "legacy", gasPrice: 0n } as never);
  const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000 });
  if (receipt.status !== "success") throw new Error(`Transaction reverted: ${hash}`);
  return hash;
}
