# Runbook: officer votes in PT Control (committee, trustee acceptance, offering approvals)

Every vote the property and offering workflows need from an officer is cast in PT Control (ADR 0011
sections 10, 12 and 13; migrations 0016, 0023, 0026). Each vote needs the officer's own security key
(step-up younger than 5 minutes), a reason of 10 to 500 characters and the digest of what the page
showed: if the file changed while you read it, the vote is refused with "reload and check again".
The database refuses the same votes under an officer's handle anywhere else (command line, scripts,
`seed:catalog`). Severity: SEV3 (work waiting); SEV2 if a vote under an officer's handle appears
without its `approval.decided` entry in the admin audit (possible tampering: see incident-response).

## Investment committee (S-01 P7)

Who: officers with an `ic_member` or `ic_independent` duty (operations makers, checkers or
compliance officers; never a party to the file: whoever entered, submitted or reviewed it).

1. **Open.** Operations > Investment committee (`/committees`), section "Ready for a committee":
   a file appears once every review passed and is fresh, the valuations are within tolerance and the
   sponsor is KYB-approved. The member who will chair clicks "Open the meeting and chair it" (reason,
   security key). The command line `property:run openIc` does the same (opening is not a vote).
2. **Vote.** Each member opens `/committees/<meeting>`, reads the due diligence (reviews, valuations,
   the legal opinion's qualifications: approving accepts them, OB-28), the current documents and
   their SHA-256, and votes **approve**, **reject** or **abstain** with a reason, or **records a
   conflict** (the reason is the conflict note; no vote). One vote per member.
3. **Close.** When the page shows quorum (3 non-conflicted votes including an independent member,
   setting `ic_quorum`), the chair hashes the signed minutes (`sha256sum minutes.pdf`), enters the
   64-character SHA-256 and a closing note and closes. Majority approve with no independent member
   against: the property becomes **Legal Approved**; otherwise the meeting closes "not approved" and
   the file stays Under Review.
4. Refusals you may see: "No quorum yet", "Only the chair closes", "You are a party to this file",
   "a member votes once per meeting", "the file differs from what you reviewed".

## Trustee acceptance (S-01 P8)

Who: trustee officers with the S-01 `trustee` duty.

1. The legal head records the structure first (`property:run recordStructure`: REIT/SPV, Shariah,
   unit rights, planned register, trust deed). Until then the page says "The legal head has not
   recorded the structure yet".
2. Trustee > Property acceptance (`/trustee/properties`), open the property. Check the structure,
   the planned register and the 10 % holding limit derived from it, the trust deed SHA-256 against the
   deed the trustee holds, the committee's minutes hash, valuations and documents.
3. **Accept for the trust** (reason, optional conditions, security key): the property becomes
   **Tokenization Ready**. **Decline**: final for that structure; the legal head records a new
   structure if the file continues, and the trustee decides on that one.

## Offering approvals (S-02 L3 and other platform votes)

Who: operations checkers and compliance officers holding the S-02 duty the request still needs:
`offering` (terms), `legal_head` (offering documents), `compliance` (eligibility, disclosures),
`bank_operator` (refunds). The trustee votes in Trustee > Co-signing (runbook trustee-operations).

1. Operations > Offering approvals (`/approvals/offering`) lists open requests with the duties still
   missing. Open one: terms (price, min raise, target, hard cap, per-investor limits, window), use of
   proceeds, SHA-256 of the English and Urdu offering documents and the risk disclosure.
2. Check the hashes against the documents you reviewed, then approve or reject with a reason. The
   maker who submitted never votes; one rejection is final.
3. **Expired or rejected L3:** the offering stays Pending Approval without a live request (listed
   under "Offerings pending approval without a live request"). On the request page, "Return to draft"
   (an officer with an offering, legal head or compliance duty, not the maker) moves it back to Draft;
   the maker updates the terms and submits again.

## Demo catalogue: DHA6 and BAO2 to an approved offering

`npm run seed:catalog` (backend/, local or demo database only) onboards the two fictional
properties ("DHA Phase 6 Retail Unit", "Blue Area Office, Floor 2") through the real workflows. It
never votes for an officer: it stops (outcome `waiting`), prints each due vote with the officer and
the PT Control page, and continues on the next run. Prerequisites: migrations up to 0026, the 14 demo
officers enrolled in PT Control with these roles (the seed prints the plan when one is missing):

| Handle | Role | Votes in this walkthrough |
|---|---|---|
| `demo.onb-1`, `demo.onb-2` | ops_maker | none (sponsor and property entry) |
| `demo.comp-1` | compliance_officer | none (K4 maker) |
| `demo.comp-2` | compliance_officer | K4 checker; L3 compliance |
| `demo.legal-1`, `demo.val-1`, `demo.tech-1` | ops_checker | none (reviews) |
| `demo.legal-head` | ops_checker | none for P8 (records the structure); L3 legal head |
| `demo.ic-1` | ops_checker | committee chair: vote and close |
| `demo.ic-2` | ops_checker | committee vote |
| `demo.ic-indep` | ops_checker | committee vote (independent member) |
| `demo.trustee-1` | trustee_officer | P8 acceptance; L3 trustee vote |
| `demo.off-maker` | ops_maker | none (creates and submits the offering) |
| `demo.off-checker` | ops_checker | L3 offering checker |

Order (each officer signs in with their own key at http://localhost:3300 through the SSH tunnel):

1. `npm run seed:catalog` -> waiting: K4 of the demo sponsor (one request for both properties).
   **demo.comp-2**: Operations > Property & KYB > the K4 request > Approve.
2. `npm run seed:catalog` -> both properties submitted, reviewed and in a committee meeting opened for
   `demo.ic-1`; waiting: 3 votes + close per property (the seed prints the meeting numbers and the
   minutes' SHA-256 of `backend/packages/offering/demo/<slug>-ic-minutes.txt`).
   For each of the two meetings: **demo.ic-1**, **demo.ic-2**, **demo.ic-indep**: Operations >
   Investment committee > meeting > Approve (reason). Then **demo.ic-1**: Close, pasting the printed
   minutes SHA-256 -> Legal Approved.
3. `npm run seed:catalog` -> the structure is recorded for `demo.legal-head`; waiting: P8.
   **demo.trustee-1**: Trustee > Property acceptance > each property > Accept for the trust ->
   Tokenization Ready.
4. `npm run seed:catalog` -> offerings created and submitted by `demo.off-maker`; waiting: 4 L3 votes
   per offering (the seed prints the request numbers). For each request: **demo.off-checker**,
   **demo.legal-head**, **demo.comp-2**: Operations > Offering approvals > request > Approve;
   **demo.trustee-1**: Trustee > Co-signing > offering request > Approve. The fourth approval moves
   the offering to **Approved**.
5. `npm run seed:catalog` -> "already approved", nothing written.

If a step takes longer than 72 hours, the L3 request expires: step 3 of "Offering approvals" above
(return to draft), then run the seed again (it refreshes the dates and resubmits).

### Still needed to reach `ready` and `live` (not built by T-046)

`offering.mark_ready` (L4) checks the chain read model, not the caller:

1. The property's token deployed through `contracts/script/DeployLib.sol` (paused, IssuanceGuard and
   IdentityRegistry), and the indexer has registered the deployment (`chain.tokens`).
2. The trustee cap set to at least the hard cap (20,000 units for DHA6, 30,000 for BAO2) through the
   72-hour timelock (60 s on the local dev chain 586586), visible in the read model.
3. The English and Urdu offering documents (`<slug>-offering-en.txt`, `-ur.txt`) anchored in that
   token's DocumentRegistry (Ops Safe; there is no `document.add` signer kind yet, see TASKS T-045;
   locally `chain/document.py`).
4. Then `npm run seed:catalog -- --token 0x<token>` records L4 for `demo.off-maker` (not a vote) and
   runs one clock tick; the offering goes live when its window opens. Limitation: `--token` takes one
   address and is tried for every approved demo offering, so with two tokens the second property is
   refused ("not anchored" or "below the hard cap") until the seed takes one token per property.
