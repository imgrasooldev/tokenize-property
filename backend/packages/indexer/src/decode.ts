import {
  distributionRegistryAbi,
  documentRegistryAbi,
  freezeGuardAbi,
  identityRegistryAbi,
  idFactoryAbi,
  issuanceGuardAbi,
  pauseGuardAbi,
  recoveryGuardAbi,
  registrarGuardAbi,
  timelockAbi,
  tokenAbi,
} from "@pt/contracts";
import { decodeEventLog, toEventSelector, type Abi, type AbiEvent } from "viem";
import type { Hex, Role } from "./deployment.ts";

/** ABI of each role, from @pt/contracts (generated from the audited build, CI checks drift). */
const ABIS: Record<Role, Abi> = {
  token: tokenAbi,
  identityRegistry: identityRegistryAbi,
  issuance: issuanceGuardAbi,
  pauseGuard: pauseGuardAbi,
  freezeGuard: freezeGuardAbi,
  recovery: recoveryGuardAbi,
  registrarGuard: registrarGuardAbi,
  distributions: distributionRegistryAbi,
  documents: documentRegistryAbi,
  timelock: timelockAbi,
  idFactory: idFactoryAbi,
};

/** Event definitions by role and topic0, built once. */
const EVENTS = new Map<Role, Map<string, AbiEvent>>(
  (Object.entries(ABIS) as [Role, Abi][]).map(([role, abi]) => [
    role,
    new Map(abi.filter((x): x is AbiEvent => x.type === "event").map((ev) => [toEventSelector(ev), ev])),
  ]),
);

/** An event definition by role and name (for tests and tools that encode events). */
export function eventAbi(role: Role, name: string): AbiEvent | undefined {
  return [...(EVENTS.get(role)?.values() ?? [])].find((e) => e.name === name);
}

/** JSON-safe event arguments: integers as decimal strings (uint8/uint16 as numbers), addresses and bytes lower-case. */
export type ArgValue = string | number | boolean | Args | ArgValue[];
export interface Args {
  [name: string]: ArgValue;
}

export interface Decoded {
  /** Event name, or null if the log does not match the contract's ABI. */
  name: string | null;
  args: Args | null;
}

/**
 * Decodes a log emitted by a contract of the given role. A log that does not match the ABI is not
 * an error: it is kept raw (name null) so that nothing on chain is ever dropped.
 */
export function decodeLog(role: Role, topics: readonly Hex[], data: Hex): Decoded {
  const topic0 = topics[0]?.toLowerCase();
  const event = topic0 ? EVENTS.get(role)?.get(topic0) : undefined;
  if (!event) return { name: null, args: null };
  try {
    const decoded = decodeEventLog({ abi: [event], topics: topics as [Hex, ...Hex[]], data, strict: true });
    const raw = new Map(Object.entries(decoded.args as unknown as Record<string, unknown>));
    const entries: [string, ArgValue][] = [];
    for (const input of event.inputs) {
      if (!input.name) return { name: null, args: null };
      entries.push([input.name, normalise(input.type, raw.get(input.name))]);
    }
    return { name: event.name, args: Object.fromEntries(entries) };
  } catch {
    return { name: null, args: null };
  }
}

/** Every event name the indexer can decode for a role (for documentation and tests). */
export function eventNames(role: Role): string[] {
  return [...(EVENTS.get(role)?.values() ?? [])].map((e) => e.name).sort();
}

/** Our events use only scalar types; anything else is not decoded (kept raw) rather than guessed. */
function normalise(type: string, value: unknown): ArgValue {
  if (type === "address" || /^bytes([1-9]|[12][0-9]|3[0-2])$/.test(type)) {
    if (typeof value !== "string") throw new Error(`expected hex for ${type}`);
    return value.toLowerCase();
  }
  if (type === "bool") {
    if (typeof value !== "boolean") throw new Error("expected a boolean");
    return value;
  }
  if (/^u?int\d+$/.test(type)) {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "number" && Number.isSafeInteger(value)) return value;
    throw new Error(`expected an integer for ${type}`);
  }
  if (type === "string") {
    if (typeof value !== "string") throw new Error("expected a string");
    return value;
  }
  throw new Error(`unsupported ABI type ${type}`);
}
