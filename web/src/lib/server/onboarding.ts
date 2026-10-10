import { encodeAbiParameters, keccak256, type Account, type Address } from "viem";
import { idFactoryAbi, identityAbi, identityRegistryAbi, registrarGuardAbi } from "../abis";
import { latestDeployment } from "./chain";
import { platformAccount, publicClient, sendAndWait } from "./demo-signer";

const TOPICS = [1n, 2n] as const; // KYC, AML
const PAKISTAN = 586;

/** Claim signature exactly as ONCHAINID verifies it: EIP-191 over keccak256(identity, topic, data). */
async function signClaim(identity: Address, topic: bigint, data: `0x${string}`): Promise<`0x${string}`> {
  const signer = platformAccount("CLAIM_SIGNER");
  const hash = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "bytes" }], [identity, topic, data]),
  );
  if (!signer.signMessage) throw new Error("claim signer cannot sign");
  return signer.signMessage({ message: { raw: hash } });
}

export interface OnboardingStep {
  key: "identity" | "kyc" | "aml" | "registered";
  tx: `0x${string}`;
}

/**
 * Real on-chain onboarding for a KYC-approved investor, the same path proven in the contract tests:
 * identity operator creates the ONCHAINID → investor adds KYC and AML claims signed by the claim
 * signer → registrar registers the wallet through the rate-limited RegistrarGuard.
 */
export async function onboardOnChain(investor: Account, salt: string): Promise<{ identity: Address; steps: OnboardingStep[] }> {
  const d = latestDeployment();
  const idFactory = d?.get("idFactory");
  const claimIssuer = d?.get("claimIssuer");
  const registrarGuard = d?.get("registrarGuard");
  if (!idFactory || !claimIssuer || !registrarGuard) throw new Error("No local deployment found. Run the demo scenario first.");

  const steps: OnboardingStep[] = [];
  steps.push({
    key: "identity",
    tx: await sendAndWait(platformAccount("IDENTITY_OPERATOR"), {
      address: idFactory,
      abi: idFactoryAbi,
      functionName: "createIdentity",
      args: [investor.address, salt],
    }),
  });
  const identity = await publicClient.readContract({
    address: idFactory,
    abi: idFactoryAbi,
    functionName: "getIdentity",
    args: [investor.address],
  });

  for (const topic of TOPICS) {
    const data = encodeAbiParameters([{ type: "string" }, { type: "uint256" }], ["verified", topic]);
    const signature = await signClaim(identity, topic, data);
    steps.push({
      key: topic === 1n ? "kyc" : "aml",
      tx: await sendAndWait(investor, {
        address: identity,
        abi: identityAbi,
        functionName: "addClaim",
        args: [topic, 1n, claimIssuer, signature, data, ""],
      }),
    });
  }

  steps.push({
    key: "registered",
    tx: await sendAndWait(platformAccount("REGISTRAR"), {
      address: registrarGuard,
      abi: registrarGuardAbi,
      functionName: "register",
      args: [investor.address, identity, PAKISTAN],
    }),
  });
  return { identity, steps };
}

export async function isVerifiedOnChain(wallet: Address): Promise<boolean | null> {
  const ir = latestDeployment()?.get("ir");
  if (!ir) return null;
  try {
    return await publicClient.readContract({ address: ir, abi: identityRegistryAbi, functionName: "isVerified", args: [wallet] });
  } catch {
    return null;
  }
}
