# ADR 0017: Encrypted document vault

- Status: Proposed (2026-10-30)
- Task: T-038; migration `0041_vault.sql`; package `@pt/vault`

## Context

Property onboarding (S-01), offerings (S-02) and the public verification page publish document HASHES (SHA-256), and the on-chain DocumentRegistry anchors them, but the platform had nowhere to keep the files themselves: investors could not download the offering document or the risk disclosure they accept, and title deeds, valuations and KYC documents had only an opaque `store_ref`.

## Decision

1. A separate vault service (`npm run vault:serve`, 127.0.0.1:4950, unit `pt-vault`) holds the only key. The website and the portal hold none (ADR 0010).
2. Each file is encrypted with its own random 256-bit data key (AES-256-GCM, 12-byte nonce, tag appended; additional data binds the plaintext hash). The data key is wrapped with the vault master key of a numbered version (`VAULT_MASTER_KEY_V<n>`, `VAULT_KEY_CURRENT`; a KMS/HSM in production, see the HSM task). Files are named by the SHA-256 of the plaintext only, under `VAULT_DIR`.
3. The database keeps metadata only (`vault.objects`: hash, size, media type, key version, wrapped key, nonce), append-only. The store reference is `vault://<sha256>`, so it fits `property.documents.store_ref` unchanged.
4. Publication rule in the database (`vault.public_document`): only the EN/UR offering document and the risk disclosure of an offering the website may show, and current public property documents of such an offering. KYC files, title deeds and valuations are never public. Unpublished and unknown hashes give the same answer.
5. Every read is logged before bytes leave the service (`vault.reads`). A read decrypts and checks the SHA-256 again; a changed file or a wrong key is refused. The website checks the hash once more before sending the file as an attachment.
6. The service connects as `pt_vault_app` (group `pt_svc_vault`, T-012): register, look up, check publication, log reads; nothing else.

## Consequences

- Investors download the offering documents they accept and the public property documents; the bytes provably match the hashes on the page and on chain.
- Operators store files with `npm run vault:put` until a portal upload screen exists; re-encryption under a new key version (key rotation) is a follow-up tool.
- Retention and erasure (ADR 0009: KYC records ten years after the relationship) need a separate, legal-approved procedure; the vault never deletes.
- Backups must include `VAULT_DIR` and the master key separately (the key never in the same backup as the files).
