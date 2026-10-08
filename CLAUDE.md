# Instructions for Claude

Read [MEMORY.md](MEMORY.md) before doing anything in this repository. It holds the decisions, status, findings and gotchas. Update it at the end of each session and at every step gate.

- Safety first: follow `docs/contract-spec.md`, `docs/threat-model.md` and `docs/security-standards.md` as the source of truth. Change the spec before changing behaviour.
- Work step by step; a step starts only after the owner approves the previous gate.
- All contract deployments go through `contracts/script/DeployLib.sol`.
- Never commit secrets, `.env` files or `.bak` files.
- The owner reads Roman Urdu in chat; write repository docs in English.
