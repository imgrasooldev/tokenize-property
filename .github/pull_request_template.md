## What and why

<!-- What does this change do, and why is it needed? Link the spec section or ADR. -->

## Security definition of done

See [docs/security-standards.md](../docs/security-standards.md#3-security-definition-of-done-every-pull-request).

- [ ] Spec or ADR updated if behaviour changed
- [ ] Threat model updated if a new asset, flow or trust boundary was added
- [ ] Tests written for the change, including failure and abuse cases
- [ ] CI green: tests, coverage, static analysis, secret scan, dependency scan
- [ ] No new dependency without justification below
- [ ] No secrets, keys or personal data in code, logs or test fixtures
- [ ] Two approving reviewers (contracts: one senior Solidity reviewer)
- [ ] Signed commits

## New dependencies

<!-- Name, version, why it is needed, who maintains it. Write "None" if none. -->
