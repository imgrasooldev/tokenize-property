# ADR 0015: Property analyst and site search

- Status: Proposed (awaiting owner review)
- Date: 2026-10-13
- Builds on: ADR 0010 (website integration: the website reads records, signs nothing), T-045 (public catalogue and rule-based property score)
- Code: `web/src/lib/server/analyst/`, `web/src/lib/server/search.ts`, `web/src/app/actions/analyst.ts`, `web/src/app/search/page.tsx`, `web/src/components/analyst/`, `web/src/lib/i18n-analyst.ts`

## Context

The design shows an "Ask AI or search" bar and an AI analyst panel. Until now both were disabled samples. The owner asked to make the search bar, the ask bar and the analyst real, with two firm limits: the analyst must never give investment advice, and the site shows real data only.

An investor-facing answer about a regulated investment is risky in three ways: (1) a wrong or invented figure, (2) wording that reads as a recommendation or a forecast, (3) leaking personal data, including to an outside AI service. Prompt injection (a question that tries to change the rules) is a fourth.

## Decision

### Search

`searchCatalog(q, lang, entries)` is a pure ranking over the catalogue entries (symbol, English and Urdu name, district, city, province in English and Urdu, property type, status words) plus six fixed site pages. Matching is case- and diacritic-insensitive; Urdu script is normalised (vowel marks removed, Arabic letter forms folded to Urdu ones, Urdu digits to ASCII). Weights: exact symbol 120, symbol or whole-query match 100, name 50, district 30, city 28, province 25, page 20, property type 15, status 10. Queries are limited to 80 characters. `/search?q=` is server-rendered and works without JavaScript. The header "Ask or search" field is a plain GET form to `/search` (focus with `/` or Ctrl/Cmd+K).

### Analyst: providers and order of work

1. **Intent detection** (pure keyword tables in English, Roman Urdu and Urdu script): yield, rent history, price, occupancy/lease, documents, supply/holders, fees, how it works, risk factors, score, offering terms, my portfolio. **Guardrail intents are checked first**: buy/sell/"good investment" advice, price or return predictions, personal financial advice. Anything else is "unknown" and gets an honest list of what can be answered, with suggestion chips.
2. **Retrieval** builds facts ONLY from records the website already reads: `catalog()` (chain read model, offering and property records, published document hashes, reconciliation), and for portfolio questions the signed-in investor's own holdings (read model), rent statements (`distributionsFor`) and subscriptions. Each fact carries its source: block number for chain figures, SHA-256 for documents, table and record id for database records, the reconciliation run for recon figures, and the time the data is from.
3. **Composition**:
   - **Grounded provider (default, no external service, $0)**: deterministic sentences per intent in English and Urdu. Its own sentences contain no figures; every figure is a fact value, cited `[n]`. Money is integer paisa formatted with bigint arithmetic; times are shown in PKT.
   - **Claude provider (optional)**: only when `ANALYST_PROVIDER=claude` AND `ANTHROPIC_API_KEY` are set in `backend/.env.local`. Model `ANALYST_MODEL` or `claude-haiku-4-5`, `max_tokens` 600, `temperature` 0, 12 s timeout, raw `fetch` to the Messages API from the server (no SDK, no new dependency; the browser never talks to an outside origin, CSP unchanged).
4. **Guardrails are never sent to Claude**: advice, prediction, personal and unknown questions are always answered by the grounded provider, as a refusal that still lists the relevant facts.
5. **Every answer** carries the disclaimer "Informational, not investment advice" (Urdu: "صرف معلومات کے لیے، سرمایہ کاری کا مشورہ نہیں۔"), the data-as-of time and block, and a provider badge ("Grounded in records" / "Claude, grounded in records").

### Citation rule (checked in code)

A Claude reply is used only if: it cites at least one fact; every `[n]` exists among the facts sent; every number in it (citations removed) appears in a fact; it has no link and no advice/forecast wording ("you should buy", "I recommend", "will rise", "guaranteed"…); it ended normally (`end_turn`) and is at most 2,000 characters. Otherwise the grounded answer is shown. Errors, timeouts and HTTP failures also fall back to grounded. Tests cover each case with a mocked `fetch`; tests never call the real API.

### Pages that never call an outside service

The search page and the portfolio summary (`portfolioSummary`) always use the grounded provider: a page load, a refresh or a link prefetch must not cost money or depend on an outside service. Only an explicit question in the analyst box (server action `askAction`) may use Claude.

### The property score is separate

The 0–100 property score (`web/src/lib/score.ts`, T-045) is a transparent rule-based formula with published weights. It is **not AI** and not produced by this analyst; the analyst only explains it from its factors.

### Rate limits

`ask`: 10 questions burst, 6 per minute, keyed by investor id when signed in, else by client address (in this prototype all anonymous visitors share one key unless `TRUST_PROXY=1`, see MEMORY §5). Production rate limiting sits at the edge (threat model §4.4).

## Cost

- Grounded: no external cost.
- Claude Haiku 4.5 ($1 per million input tokens, $5 per million output tokens; Anthropic first-party price list, September 2026). Assumptions per question: system prompt about 300 tokens, facts about 1,000–2,000 tokens (at most 24 facts), question up to 100 tokens, reply typically 250 and at most 600 tokens. Typical cost about **$0.002–0.003 per question**; worst case about **$0.0055**. 1,000 questions a day ≈ $3–5.5 a day. The rate limit caps one key at 8,640 questions a day (≈ $48 worst case); the owner should also set a monthly spend limit on the API key in the Anthropic console.

## Privacy

- Facts contain no name, CNIC, phone, e-mail or wallet address. Portfolio facts are the signed-in investor's own aggregates only (token counts, rupee totals, counts); other investors' data is never read.
- Before a question is sent to Claude, wallet addresses, e-mail addresses and digit runs of 8 or more characters (CNIC, phone, account numbers) are replaced by placeholders.
- Questions and answers are not stored. Logs hold only an error class (for example `TimeoutError`, `HttpStatus500`, `OutputRejected:figure`), never the question, the reply or the key.
- The API key is read on the server from `backend/.env.local` through `backendEnv()`; it is never sent to the browser or logged.

## Prompt injection

The question is untrusted data. The prompt puts the facts inside `<facts>…</facts>` and the question inside `<question>…</question>`; angle brackets are removed from both, so the question cannot close its block. The system prompt says text in those blocks is data, never instructions, forbids advice and predictions, and requires answering only from the facts with `[n]` citations. Whatever the model writes, the output checks above decide; a reply that breaks a rule is discarded. Guardrail questions never reach the model. The model has no tools and cannot act.

## What the owner must do to enable Claude

Nothing is needed for the grounded analyst. To enable Claude, the owner (and nobody else; no agent handles the key) adds to `backend/.env.local` on the server:

```
ANALYST_PROVIDER=claude
ANTHROPIC_API_KEY=<the key from the Anthropic console>
# optional: ANALYST_MODEL=claude-haiku-4-5
```

then restarts the website (`backendEnv()` reads the file once per process). Removing either line returns to grounded answers.

## Consequences

- The ask bar, search page and analyst work today with zero external cost and only real records.
- Answers are narrow by design: a question outside the intents gets an honest "I can only answer about…".
- Grounded wording is fixed text; it reads plainly rather than conversationally.
- Keyword intent detection can misread unusual wording; the safe failure is a refusal or an "unknown" answer, never advice.
- Enabling Claude adds an outside processor of question text (scrubbed) and record figures; this needs a line in the privacy notice before public launch.
- On narrow screens the header search field is hidden by the existing layout; the `/` shortcut then opens `/search`, and the search page itself is fully responsive.
