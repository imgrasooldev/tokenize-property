# Demo guide: investor website prototype

A 15-minute script for presenting the prototype to the team. Everything runs on one laptop: a four-validator Besu network, PostgreSQL 18 and the Next.js website. All properties are samples and all money is test money.

## Before the meeting (5 minutes)

One-time setup on a new machine: `chain/README.md` (Besu, JDK, `net.py setup`), `backend/README.md` (PostgreSQL, `pg.py setup`, migrations), `python chain/flow.py` (deploys the contracts and creates Alice and Bob), `npm run setup:demo` in `web/`, and optionally `python chain/rent.py` (a rent distribution to verify).

Then, before each presentation:

```bash
python scripts/demo.py up --trade
```

This starts the chain, PostgreSQL and the website on http://127.0.0.1:3100, compiles the main pages so nothing is slow on stage, and starts about five minutes of demo trading so the market chart is moving. Afterwards: `python scripts/demo.py down` (add `--all` to stop the chain and database too).

## The script

| # | Show | Say |
|---|---|---|
| 1 | Home page | "Each property is held by an independent trustee. Investors hold tokens that mirror the trustee's register. Money only ever moves in PKR through banks and Raast; the blockchain records ownership, not money." Point at the **Live on chain** badge: those figures are read from the blockchain as the page opens. |
| 2 | Toggle **اردو** | Full Urdu, right to left. Toggle back. |
| 3 | **Sign in → Create an account** | Mock NADRA: enter a CNIC ending in **0** → refused. Enter a valid one → the account is registered **on the blockchain for real** (identity, signed KYC and AML claims, registry). "We never store the full CNIC or phone number." |
| 4 | **Gulberg Plaza** property page | Price, yield, NAV and rent charts (sample history), live supply and the trustee's cap. |
| 5 | **Invest** 100 tokens, tick the Raast box | Explain the order: payment recorded in the ledger first, then the tokens are minted with a one-time reference, so a double-click can never charge or mint twice. |
| 6 | **Portfolio** | Holdings read from the chain, the mint transaction, and four green checks: the ledger, the blockchain and the order book agree. "These checks run every time the page opens." |
| 7 | **Verify my share on chain** (rent) | "Only a fingerprint of the rent statement is on the blockchain. Each investor can prove their own share without seeing anyone else's, and 1 paisa more is rejected." |
| 8 | **Market** (sign in as Bob) | Point at the **DEMO** banner: secondary trading needs SECP approval and a licensed broker. Show the live candles moving (demo trading), the NAV line, the ±10% band. |
| 9 | Place a buy order that crosses the best ask | The trade settles on chain within seconds. "Tokens move first; the cash leaves escrow only after the blockchain confirms. If the chain refuses, for example a frozen wallet, everything is undone." |
| 10 | Open the page in a second window | The second window updates live without a reload. |

## Likely questions

- **Is this live / can we launch?** No. It is a prototype on a local test network. Before launch: two external smart-contract audits, formal verification, a penetration test, the backend Steps 5c–5h (outbox, HSM/MPC signing service, indexer, reconciliation), the internal portals, and SECP approval.
- **Where are the private keys?** Here, local test keys and an AES-encrypted demo wallet store. In production: a hardware security module or MPC, multisig for every admin role, and a 72-hour timelock on changes.
- **What if the platform disappears?** The trustee holds the property and the register; the token mirrors it. The blockchain is anchored hourly to a public chain.
- **How fast is it?** Pages render in about 10–30 ms in a production build (measured on this laptop); a trade settles in about 2–3 s, mostly the 2-second block time.

## If something goes wrong

| Symptom | Fix |
|---|---|
| "Live chain data is unavailable" | `python chain/net.py status`; if down, `python scripts/demo.py up` |
| Sign-in or invest fails with a database error | `python backend/scripts/pg.py start` |
| Market chart is empty | `cd web && npm run demo:market -- 20 5` |
| A page is slow the first time | It is compiling; `demo.py up` normally does this in advance |
| "Too many attempts" | Rate limit; wait a minute |
