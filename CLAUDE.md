# Instructions for Claude

Read [MEMORY.md](MEMORY.md) before doing anything in this repository. It holds the decisions, status, findings and gotchas. Update it at the end of each session and at every step gate.

- Safety first: follow `docs/contract-spec.md`, `docs/threat-model.md` and `docs/security-standards.md` as the source of truth. Change the spec before changing behaviour.
- Work step by step; a step starts only after the owner approves the previous gate.
- All contract deployments go through `contracts/script/DeployLib.sol`.
- Never commit secrets, `.env` files or `.bak` files.
- The owner reads Roman Urdu in chat; write repository docs in English.

## How to work (token-efficient)

1. Read this file, then [docs/CURRENT_STATUS.md](docs/CURRENT_STATUS.md) and [docs/TASKS.md](docs/TASKS.md). Open other docs (index in [docs/PROJECT_OVERVIEW.md](docs/PROJECT_OVERVIEW.md)) and files only when the task needs them.
2. Search (Grep/Glob) before creating anything; reuse existing packages and SQL functions.
3. Plan first for complex changes; take one task at a time; make the smallest safe change.
4. Run targeted tests first, then the full suite (`forge test`, `cd backend && npm run check`, `cd web && npm run check`) before merging; inspect the diff.
5. After a verified change, update docs/CURRENT_STATUS.md, docs/TASKS.md, docs/CHANGELOG.md and the MEMORY.md log.
6. Never mark untested work as complete; label it Partial or Untested.
