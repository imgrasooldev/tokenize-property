# Coding Standards

Existing conventions only, as found on `main` @ `41241b3` (2026-10-13). Security rules come first from [security-standards.md](security-standards.md) (definition of done per PR) and [threat-model.md](threat-model.md).

## 1. General

- Spec first, then tests, then code. If behaviour changes, update `docs/contract-spec.md` or an ADR first (CLAUDE.md, README ground rules).
- Repository docs in English; owner chat in Roman Urdu (CLAUDE.md).
- No secrets, `.env*` (except `.env.example`), keys, keystores or `.bak` files in git (`.gitignore`; gitleaks in CI). Secrets are created by `setup` scripts into git-ignored `backend/.env.local` / `web/.env.local`.
- LF line endings (`.gitattributes`: `* text=auto eol=lf`).
- Money is integer: PKR in **paisa** as `bigint` (TS) / `bigint` (SQL); token amounts and uint256 as `numeric(78,0)` in SQL and `bigint` in TS. Never floating point (comments in `0002_ledger.sql`, eslint rule note in `backend/eslint.config.mjs`).
- Timestamps that are hashed are formatted explicitly in UTC (finding F-04, `0008_review_fixes.sql`).

## 2. TypeScript (backend and web)

| Setting | Backend `backend/tsconfig.json` | Web `web/tsconfig.json` |
|---|---|---|
| `strict` | yes | yes |
| `noUncheckedIndexedAccess` | yes | yes |
| `exactOptionalPropertyTypes` | yes | no |
| `noImplicitOverride` | yes | yes |
| Module | NodeNext, `.ts` import extensions, `verbatimModuleSyntax` | Next.js bundler, `@/` alias |

- Node >= 24 (`engines`, `engine-strict=true`). ES modules (`"type": "module"`).
- TypeScript pinned to **6.0.3** (typescript-eslint supports < 6.1).
- Input validation with **zod 4** at every boundary (server actions, HTTP bodies, policy payloads, bank events; `strictObject` for external events).
- Errors: typed error classes per package (`KycError`, `BankError`, `RefusedError`, `TransientError`, `DeferredError`, `AnchorAlarm`); HTTP handlers never echo internal errors (`{error: "internal"}`).
- Logging: `@pt/logger` (pino with redaction) in backend; `logError` in web without personal data.

## 3. Lint (`eslint . --max-warnings 0`)

Both `backend/eslint.config.mjs` and `web/eslint.config.mjs`: `@eslint/js` recommended, `typescript-eslint` **strictTypeChecked**, `eslint-plugin-security` recommended, `restrict-template-expressions` (numbers allowed), `no-console: error`, `eqeqeq: always`. Backend adds `no-floating-promises: error`, allows console in `scripts/` and `cli.ts`, and relaxes `detect-non-literal-fs-filename` in tests. `eslint-config-next` is deliberately not used (dependency advisory, web/README.md).

## 4. Dependencies (`.npmrc` in backend and web)

`save-exact=true`, `ignore-scripts=true`, `engine-strict=true`, `audit-level=high`. Install with `npm ci --ignore-scripts`; CI runs `npm audit --audit-level=high`. A new dependency needs a justification in the PR (template). The web ABI file must be identical to the backend's (`npm run sync:abis`; CI `cmp`).

## 5. SQL and migrations

- Files `backend/packages/db/migrations/NNNN_name.sql`, next number, no gaps. **Never edit a committed migration** (runner refuses changed checksums); fix forward with a new migration using additive DDL or `CREATE OR REPLACE`.
- Each migration header lists its safety rules with IDs (L-, O-, S-, C-, R-, A-, Y-, B-, H-, I-) and tests reference them.
- Rules live in the database: `SECURITY DEFINER` functions with `SET search_path`, `REVOKE ALL ... FROM PUBLIC`, NOLOGIN roles per service, append-only triggers, hash-chained audit tables.
- Use `IS DISTINCT FROM` (never `<>`) for values that may be NULL (F-06). Avoid counted regex repetition in hot CHECKs; use `length(x) = 66 AND x ~ '^0x[0-9a-f]+$'` (`0005` comment).
- Beware `STRICT` functions returning NULL on a NULL argument (MEMORY.md §5).

## 6. Solidity

- solc 0.8.30 for our code (vendor 0.8.17 via its pragmas), OpenZeppelin 5 for our code and 4.9.6 for vendor code via context remappings (exact versions 5.6.1/4.9.6 per MEMORY.md §2; submodules were not checked out in the audit worktree, so not re-verified), EVM cancun, optimizer 200 runs, no via-IR (`contracts/foundry.toml`).
- Fuzz 2,000 runs with fixed seed `0x5eed`; invariant tests in `contracts/test/invariant/`.
- `forge fmt --check`, Slither with `fail-on: low` in CI; 100% coverage target outside vendor/lib/script (MEMORY.md §3).
- All deployments through `contracts/script/DeployLib.sol`; tests use the same library.
- Vendor imports stay in separate files (`ERC3643Suite.sol`, `TrexModules.sol`).

## 7. Tests

| Kind | Where | Pattern |
|---|---|---|
| Unit | `backend/packages/*/test/*.test.ts`, `web/test/*.test.ts` | vitest 5; backend files run serially (`fileParallelism: false`), `testTimeout` 30 s, `hookTimeout` 60 s |
| Database | `*-db.test.ts` | each file builds a **scratch database** with all migrations (`backend/packages/db/test/helpers.ts` `scratchDatabase`, `migrationsUpTo`, `addMigrationsAfter` for upgrade tests) |
| Property | fast-check 4.10.2 in `anchorer`, `e2e-recon`, `indexer-db`, `balances`, `ledger`, `worker`, `recon/property` tests | random faults, crashes, racing workers against a reference model |
| Mutation (manual) | documented in READMEs and commit messages | a deliberate break (e.g. broadcast before record) must make the property test fail; check that the mutation really applied |
| Integration on chain | `local-chain.test.ts`, `e2e-*.test.ts`, `web/test/*.integration.test.ts` | `describe.skipIf(!live)` when Besu/Anvil is not running (so they skip in CI) |
| Web e2e | `web/e2e/*.spec.ts` | Playwright 1.64 in installed Edge, own server on 3101, `WEB_DB_NAME=property_token_test`; not in CI |
| Contracts | `contracts/test/*.t.sol` | unit, fuzz, invariant, finding proofs |

Timing assertions: medians, not means; on CI (`CI=true`) only the median is a gate and p99 is printed (MEMORY.md §5, `backend/packages/signer/test/service.test.ts`). Tail-latency gates in unit tests are known to be load-sensitive (task T-001).

Test databases: only `property_token_test` is honoured by web tests (`WEB_DB_NAME`).

## 8. Commits and branches

- Messages: imperative summary line, either Conventional Commits (`feat(web): ...`, `fix(deploy): ...`, `docs(memory): ...`, `test(signer): ...`) or `Step 5x: ...` for step work; body explains what and why, with numbers where measured.
- Every commit ends with a `Co-Authored-By:` trailer (60 of 60 commits on `main`).
- Merges of step branches use `Merge Step 5e: ...` style messages.
- The PR template asks for signed commits and two reviewers; on `main` today 0 of 60 commits are signed and work is pushed to `main` directly (owner preference in MEMORY.md §9). See task T-014.
