/* eslint-disable security/detect-non-literal-regexp, security/detect-unsafe-regex, security/detect-object-injection -- test-only validator: patterns and keys come from the repository's own OpenAPI document */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Contract tests (ADR 0018 section 1): every response body is validated against the schema the
 * OpenAPI document gives for its operation and status. A small validator for the JSON Schema 2020-12
 * subset the contract uses (type with null, required, properties, no undeclared properties, enum,
 * const, pattern, items, oneOf, $ref, format date-time/uuid/uri), so no new dependency is needed.
 */
type Schema = Record<string, unknown>;
export const OPENAPI = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../docs/api/openapi.json", import.meta.url)), "utf8")) as {
  paths: Record<string, Record<string, { responses: Record<string, { $ref?: string; content?: Record<string, { schema: Schema }> }> }>>;
  components: { schemas: Record<string, Schema>; responses: Record<string, { content?: Record<string, { schema: Schema }> }> };
};

function resolve(ref: string): Schema {
  const parts = ref.replace(/^#\//, "").split("/");
  let cur: unknown = OPENAPI;
  for (const p of parts) cur = (cur as Record<string, unknown>)[p];
  return cur as Schema;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

export function validate(schema: Schema, value: unknown, path = "$"): string[] {
  if (typeof schema.$ref === "string") return validate(resolve(schema.$ref), value, path);
  const errors: string[] = [];
  if (Array.isArray(schema.oneOf)) {
    const ok = (schema.oneOf as Schema[]).filter((s) => validate(s, value, path).length === 0).length;
    return ok === 1 ? [] : [`${path}: matches ${String(ok)} of oneOf`];
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    const t = typeOf(value);
    if (!types.includes(t) && !(t === "integer" && types.includes("number"))) return [`${path}: ${t} is not ${types.join("|")}`];
  }
  if ("const" in schema && value !== schema.const) errors.push(`${path}: ${JSON.stringify(value)} is not ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) errors.push(`${path}: ${JSON.stringify(value)} not in enum`);
  if (typeof value === "string") {
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) errors.push(`${path}: ${value} does not match ${schema.pattern}`);
    if (schema.minLength !== undefined && value.length < (schema.minLength as number)) errors.push(`${path}: too short`);
    if (schema.format === "date-time" && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) errors.push(`${path}: not RFC 3339`);
    if (schema.format === "uuid" && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)) errors.push(`${path}: not a uuid`);
    if (schema.format === "uri" && !/^https?:\/\//.test(value)) errors.push(`${path}: not a URI`);
  }
  if (Array.isArray(value) && schema.items) value.forEach((v, i) => errors.push(...validate(schema.items as Schema, v, `${path}[${String(i)}]`)));
  if (typeOf(value) === "object" && (schema.properties || schema.required)) {
    const obj = value as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, Schema>;
    for (const r of (schema.required ?? []) as string[]) if (!(r in obj)) errors.push(`${path}: missing ${r}`);
    for (const [k, v] of Object.entries(obj)) {
      const p = props[k];
      if (!p) errors.push(`${path}: undeclared property ${k}`);
      else errors.push(...validate(p, v, `${path}.${k}`));
    }
  }
  return errors;
}

/** The schema of an operation's response (path template, method, status, media type). */
export function responseSchema(pathTemplate: string, method: string, status: number): { media: string; schema: Schema } | null {
  const op = OPENAPI.paths[pathTemplate]?.[method.toLowerCase()];
  if (!op) throw new Error(`the contract has no ${method} ${pathTemplate}`);
  let r = op.responses[String(status)];
  if (!r) throw new Error(`the contract has no ${String(status)} for ${method} ${pathTemplate}`);
  if (r.$ref) r = resolve(r.$ref);
  const media = r.content ? Object.keys(r.content)[0] : undefined;
  return media && r.content ? { media, schema: r.content[media]?.schema ?? {} } : null;
}
