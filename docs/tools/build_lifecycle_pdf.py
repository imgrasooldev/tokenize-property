"""Builds docs/Development-Lifecycle.pdf.

Run from the repository root:  python docs/tools/build_lifecycle_pdf.py
Edit the content below (not the PDF) when the lifecycle or status changes.
"""

from datetime import date
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    CondPageBreak,
    Frame,
    KeepTogether,
    NextPageTemplate,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "docs" / "Development-Lifecycle.pdf"
VERSION = "1.0"
UPDATED = date(2026, 10, 8)

# ---------------------------------------------------------------- fonts and colours

FONT_DIR = Path("C:/Windows/Fonts")
pdfmetrics.registerFont(TTFont("Body", str(FONT_DIR / "segoeui.ttf")))
pdfmetrics.registerFont(TTFont("Body-Bold", str(FONT_DIR / "segoeuib.ttf")))
pdfmetrics.registerFont(TTFont("Body-Light", str(FONT_DIR / "segoeuisl.ttf")))
pdfmetrics.registerFont(TTFont("Mono", str(FONT_DIR / "consola.ttf")))
pdfmetrics.registerFont(TTFont("Symbol2", str(FONT_DIR / "seguisym.ttf")))
pdfmetrics.registerFontFamily("Body", normal="Body", bold="Body-Bold", italic="Body", boldItalic="Body-Bold")

NAVY = colors.HexColor("#12263A")
TEAL = colors.HexColor("#0F766E")
TEAL_LIGHT = colors.HexColor("#E6F2F1")
AMBER = colors.HexColor("#B45309")
AMBER_LIGHT = colors.HexColor("#FDF3E7")
INK = colors.HexColor("#1F2933")
MUTED = colors.HexColor("#5B6770")
RULE = colors.HexColor("#D5DBE0")
ZEBRA = colors.HexColor("#F5F7F9")
GREEN = colors.HexColor("#15803D")
GREEN_LIGHT = colors.HexColor("#E8F5EC")
GREY_LIGHT = colors.HexColor("#EEF1F4")

STATUS_COLOURS = {
    "Done": (GREEN, GREEN_LIGHT),
    "Done (internal)": (GREEN, GREEN_LIGHT),
    "In progress": (AMBER, AMBER_LIGHT),
    "Next": (TEAL, TEAL_LIGHT),
    "Not started": (MUTED, GREY_LIGHT),
    "Ongoing": (MUTED, GREY_LIGHT),
}

# ---------------------------------------------------------------- styles

S = {
    "body": ParagraphStyle("body", fontName="Body", fontSize=9.6, leading=14, textColor=INK, spaceAfter=5),
    "small": ParagraphStyle("small", fontName="Body", fontSize=8.4, leading=11.5, textColor=INK),
    "cell": ParagraphStyle("cell", fontName="Body", fontSize=8.6, leading=11.8, textColor=INK),
    "cellb": ParagraphStyle("cellb", fontName="Body-Bold", fontSize=8.6, leading=11.8, textColor=INK),
    "head": ParagraphStyle("head", fontName="Body-Bold", fontSize=8.6, leading=11.5, textColor=colors.white),
    "h1": ParagraphStyle("h1", fontName="Body-Bold", fontSize=19, leading=24, textColor=NAVY, spaceBefore=2, spaceAfter=4),
    "h1sub": ParagraphStyle("h1sub", fontName="Body-Light", fontSize=10.5, leading=15, textColor=MUTED, spaceAfter=10),
    "h2": ParagraphStyle("h2", fontName="Body-Bold", fontSize=12.5, leading=17, textColor=TEAL, spaceBefore=10, spaceAfter=4),
    "h3": ParagraphStyle("h3", fontName="Body-Bold", fontSize=10, leading=14, textColor=NAVY, spaceBefore=6, spaceAfter=2),
    "bullet": ParagraphStyle(
        "bullet", fontName="Body", fontSize=9.4, leading=13.5, textColor=INK, leftIndent=12, bulletIndent=2, spaceAfter=2
    ),
    "callout": ParagraphStyle("callout", fontName="Body", fontSize=9.2, leading=13.5, textColor=INK),
    "code": ParagraphStyle("code", fontName="Mono", fontSize=8.2, leading=11, textColor=INK),
    "toc": ParagraphStyle("toc", fontName="Body", fontSize=10, leading=17, textColor=INK),
}

CONTENT_W = A4[0] - 36 * mm


def P(text, style="body"):
    return Paragraph(text, S[style])


def bullets(items, style="bullet"):
    return [Paragraph(i, S[style], bulletText="•") for i in items]


def h1(title, subtitle=None):
    out = [P(title, "h1")]
    if subtitle:
        out.append(P(subtitle, "h1sub"))
    return out


def table(rows, widths, header=True, zebra=True, bold_first_col=False, valign="TOP"):
    data = []
    for r, row in enumerate(rows):
        cells = []
        for c, value in enumerate(row):
            if isinstance(value, str):
                if header and r == 0:
                    style = "head"
                elif bold_first_col and c == 0:
                    style = "cellb"
                else:
                    style = "cell"
                cells.append(Paragraph(value, S[style]))
            else:
                cells.append(value)
        data.append(cells)
    t = Table(data, colWidths=[w * CONTENT_W for w in widths], repeatRows=1 if header else 0)
    cmds = [
        ("VALIGN", (0, 0), (-1, -1), valign),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4.5),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
    ]
    if header:
        cmds += [("BACKGROUND", (0, 0), (-1, 0), NAVY), ("LINEBELOW", (0, 0), (-1, 0), 0, NAVY)]
    if zebra:
        start = 1 if header else 0
        for i in range(start, len(data)):
            if (i - start) % 2 == 1:
                cmds.append(("BACKGROUND", (0, i), (-1, i), ZEBRA))
    t.setStyle(TableStyle(cmds))
    return t


def status_chip(status):
    fg, bg = STATUS_COLOURS.get(status, (MUTED, GREY_LIGHT))
    chip = Table(
        [[Paragraph(status, ParagraphStyle("chip", fontName="Body-Bold", fontSize=7.8, leading=10, textColor=fg))]],
        style=TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), bg),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 1.5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5),
            ]
        ),
        hAlign="LEFT",
    )
    return chip


def callout(text, kind="info"):
    fg, bg = (TEAL, TEAL_LIGHT) if kind == "info" else (AMBER, AMBER_LIGHT)
    t = Table([[Paragraph(text, S["callout"])]], colWidths=[CONTENT_W])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, -1), bg),
                ("LINEBEFORE", (0, 0), (0, -1), 3, fg),
                ("LEFTPADDING", (0, 0), (-1, -1), 10),
                ("RIGHTPADDING", (0, 0), (-1, -1), 10),
                ("TOPPADDING", (0, 0), (-1, -1), 7),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
            ]
        )
    )
    return t


# ---------------------------------------------------------------- page templates


def draw_cover(canvas, doc):
    w, h = A4
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, 0, w, h, stroke=0, fill=1)
    canvas.setFillColor(TEAL)
    canvas.rect(0, h * 0.42, w, 4, stroke=0, fill=1)

    # Simple token-grid motif.
    canvas.setStrokeColor(colors.HexColor("#1E3A52"))
    canvas.setLineWidth(0.6)
    for i in range(7):
        for j in range(5):
            x, y = w - 175 + i * 22, h - 230 + j * 22
            canvas.rect(x, y, 14, 14, stroke=1, fill=0)
    canvas.setFillColor(TEAL)
    for i, j in [(1, 1), (2, 3), (4, 2), (5, 4), (6, 0), (3, 0)]:
        canvas.rect(w - 175 + i * 22, h - 230 + j * 22, 14, 14, stroke=0, fill=1)

    canvas.setFillColor(colors.HexColor("#8FB8B3"))
    canvas.setFont("Body-Bold", 10)
    canvas.drawString(22 * mm, h - 40 * mm, "PROPERTY TOKEN  ·  PAKISTAN")

    canvas.setFillColor(colors.white)
    canvas.setFont("Body-Bold", 34)
    canvas.drawString(22 * mm, h * 0.42 + 70, "Development")
    canvas.drawString(22 * mm, h * 0.42 + 28, "Lifecycle")

    canvas.setFont("Body-Light", 13)
    canvas.setFillColor(colors.HexColor("#C9D6E2"))
    canvas.drawString(22 * mm, h * 0.42 - 30, "From legal foundation to production operations:")
    canvas.drawString(22 * mm, h * 0.42 - 48, "phases, gates, standards and current status.")

    canvas.setFont("Body", 9.5)
    canvas.setFillColor(colors.HexColor("#9FB2C3"))
    meta = [
        f"Version {VERSION}",
        f"Updated {UPDATED.strftime('%d %B %Y')}",
        "Repository: github.com/imgrasooldev/tokenize-property",
        "Classification: Internal",
    ]
    for i, line in enumerate(meta):
        canvas.drawString(22 * mm, 40 * mm - i * 14, line)
    canvas.restoreState()


def draw_page(canvas, doc):
    w, h = A4
    canvas.saveState()
    canvas.setFillColor(NAVY)
    canvas.rect(0, h - 11 * mm, w, 11 * mm, stroke=0, fill=1)
    canvas.setFillColor(colors.white)
    canvas.setFont("Body-Bold", 8.5)
    canvas.drawString(18 * mm, h - 7 * mm, "Property Token")
    canvas.setFont("Body", 8.5)
    canvas.setFillColor(colors.HexColor("#C9D6E2"))
    canvas.drawRightString(w - 18 * mm, h - 7 * mm, "Development Lifecycle")
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.5)
    canvas.line(18 * mm, 13 * mm, w - 18 * mm, 13 * mm)
    canvas.setFont("Body", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 8.5 * mm, f"v{VERSION} · {UPDATED.isoformat()} · Internal")
    canvas.drawRightString(w - 18 * mm, 8.5 * mm, f"Page {doc.page}")
    canvas.restoreState()


# ---------------------------------------------------------------- content

PHASES = [
    {
        "n": "0",
        "name": "Legal and business foundation",
        "time": "1–2 months (parallel)",
        "status": "In progress",
        "objective": "Make the token legally meaningful before any code depends on the structure.",
        "activities": [
            "Choose the legal route with counsel and SECP: REIT under the REIT Regulations, or the SECP regulatory sandbox.",
            "Agree terms with an independent trustee (e.g. CDC) who holds the property and the register.",
            "Select the first property; verify title (Sub-Registrar, fard/PLRA, housing society NOC, encumbrance search).",
            "Appoint a Shariah advisor; obtain two independent PBA-panel valuations.",
            "Legal opinion on the ERC-3643 GPL-3.0 licence.",
        ],
        "deliverables": "Legal structure memo, trustee term sheet, title report, valuation reports, Shariah opinion.",
        "standards": "FATF R.10/R.15, AML Act 2010, SECP rules, PVARA rules as issued.",
        "gate": "Legal structure final and trustee engaged. Code that depends on it does not start before this.",
    },
    {
        "n": "1",
        "name": "Requirements and threat model",
        "time": "3–4 weeks",
        "status": "Done",
        "objective": "Write down what the system must do, what it must never allow, and who might attack it.",
        "activities": [
            "Functional requirements: onboarding, KYC, invest, rent payout, transfer, exit, admin flows.",
            "Non-functional requirements: security, 99.9% uptime, p95 under 100 ms for reads, compliance.",
            "STRIDE threat model per component, plus insider and supply-chain threats; abuse cases.",
        ],
        "deliverables": "docs/threat-model.md (50+ threats with controls), docs/product-map.md, security-standards.md.",
        "standards": "NIST CSF 2.0 (identify), OWASP SAMM (threat assessment).",
        "gate": "Every high risk has a named control. Passed 2026-10-08.",
    },
    {
        "n": "2",
        "name": "Architecture and design",
        "time": "4–6 weeks",
        "status": "Done",
        "objective": "Fix the architecture and contract behaviour on paper, where mistakes are cheapest.",
        "activities": [
            "System architecture: chain never in the read path; signing service isolated; read model + indexer.",
            "Contract specification: every function, role, limit and invariant written in English first.",
            "Stack decision (ADR 0001): Solidity + Foundry, ERC-3643, Besu QBFT, NestJS/Fastify, PostgreSQL, Next.js, Flutter.",
            "Key ceremony plan and multisig signer allocation.",
        ],
        "deliverables": "docs/contract-spec.md (v0.3, invariants I-1 to I-17), docs/decisions/0001-stack.md.",
        "standards": "EthTrust [Q] documentation requirements, NIST SSDF (PO, PW.1).",
        "gate": "Architecture review completed; external security consultant review recommended before Phase 5.",
    },
    {
        "n": "3",
        "name": "Development",
        "time": "4–5 months",
        "status": "In progress",
        "objective": "Build the system in seven gated steps, smart contracts first because everything depends on them.",
        "activities": [
            "Step 1 Repo and CI · Step 2 Specs · Step 3 Contracts · Step 4 Local chain.",
            "Step 5 Backend services · Step 6 Internal portals · Step 7 Investor apps and website.",
            "Two-week sprints; every change through a pull request with two reviewers and green CI.",
            "Tests for every invariant written together with the function, never afterwards.",
        ],
        "deliverables": "Working system on the local chain; see the Development Flow section for per-step detail.",
        "standards": "Per-step standards table (EthTrust, ASVS L3, MASVS L2+R, CCSS III, CIS).",
        "gate": "Feature complete; coverage at target; no open high static-analysis findings.",
    },
    {
        "n": "4",
        "name": "Testing and hardening",
        "time": "6–8 weeks",
        "status": "Not started",
        "objective": "Prove the whole system holds under attack, failure and load.",
        "activities": [
            "Formal verification of the guard contracts (Certora or Halmos); extended fuzzing campaigns.",
            "End-to-end flows: KYC → invest → mint → rent → payout → transfer → exit.",
            "Failure tests: bank API down, validator down, duplicate requests, indexer lag.",
            "Load test at 5× expected traffic; internal security review; first penetration test; DR restore drill.",
        ],
        "deliverables": "Formal verification report, test reports, pen-test report, DR drill record.",
        "standards": "OWASP ASVS L3 verification, MASTG, CIS Benchmarks.",
        "gate": "All critical and high issues fixed and retested.",
    },
    {
        "n": "5",
        "name": "External audits",
        "time": "6–8 weeks",
        "status": "Not started",
        "objective": "Independent confirmation by two separate firms.",
        "activities": [
            "Code freeze on contracts for the audit window.",
            "Two independent smart-contract audits, including vendored T-REX modules and findings F-01 to F-03.",
            "Fix findings; auditors review the fix diff; publish reports.",
            "External penetration test of APIs, portals and apps; EthTrust [Q] assessment by an auditor.",
        ],
        "deliverables": "Two audit reports, fix-review letters, pen-test report, EthTrust assessment.",
        "standards": "EthTrust [Q], OWASP ASVS L3, OWASP MASVS L2+R.",
        "gate": "Zero open critical or high findings. Any later contract change needs a re-audit, no exceptions.",
    },
    {
        "n": "6",
        "name": "Pilot (SECP sandbox)",
        "time": "2–3 months",
        "status": "Not started",
        "objective": "Run real money at small scale under regulatory supervision.",
        "activities": [
            "One fully let commercial property; 50–200 invited investors with per-investor caps.",
            "Two to three full rent cycles; daily three-way reconciliation must match every day.",
            "Bug bounty live; incident drills (key leak, pause, recovery) with timed response.",
        ],
        "deliverables": "Pilot report to SECP, reconciliation history, incident drill records.",
        "standards": "CCSS III operations, NIST CSF respond/recover.",
        "gate": "No money or ownership mismatch during the pilot; regulator approval to scale.",
    },
    {
        "n": "7",
        "name": "Production launch",
        "time": "2–4 weeks",
        "status": "Not started",
        "objective": "Go live with the audited code and no residual deployer power.",
        "activities": [
            "Recorded key ceremony with the auditor present; Safes created on hardware wallets.",
            "Deploy through DeployLib; run checkHandover; verify bytecode against the audited commit.",
            "Destroy the deployer key. After 72h: timelock sets the trustee cap; Admin Safe unpauses (tokens deploy paused).",
            "24/7 on-call and monitoring live; launch with low limits and raise gradually.",
        ],
        "deliverables": "Deployment record, ceremony video, bytecode verification, go-live sign-off.",
        "standards": "SLSA L3 provenance, CCSS III key generation, EthTrust deployment checks.",
        "gate": "Go-live sign-off by Admin Safe signers and the trustee.",
    },
    {
        "n": "8",
        "name": "Operations and maintenance",
        "time": "Continuous",
        "status": "Not started",
        "objective": "Keep the system safe, reconciled and compliant for its whole life.",
        "activities": [
            "Daily reconciliation; weekly alert review and dependency updates; monthly access review.",
            "Quarterly key-rotation and disaster-recovery drills; pen test every 6 months; yearly red team and audit.",
            "Upgrades only: proposal → audit → 72h timelock queue → public notice → multisig execution.",
        ],
        "deliverables": "Operations logs, drill records, audit reports, ISO 27001 / SOC 2 evidence.",
        "standards": "ISO 27001, SOC 2 Type II, ISO 27701, CIS Controls v8 IG3.",
        "gate": "Continuous; reviewed at every certification audit.",
    },
]

STEPS = [
    ("1", "Repo setup, CI, stack decision", "Done", "Monorepo, CI (tests, Slither, gitleaks), ADR 0001, PR template."),
    ("2", "Contract spec and threat model", "Done", "Spec v0.3 with invariants I-1 to I-17; STRIDE threat model; standards baseline."),
    (
        "3",
        "Smart contracts",
        "Done (internal)",
        "5 guards, 2 registries, public anchor on ERC-3643 4.1.3 + T-REX 4.1.6 modules. 120 tests, 100% coverage, "
        "Slither 0, EthTrust [Q] self-assessment, deploy verified on Anvil.",
    ),
    ("4", "Local chain", "Next", "Anvil, then a 4-validator Besu QBFT network on Java 21; deploy via DeployLib."),
    ("5", "Backend services", "Not started", "Ledger, outbox, signing service + policy engine, indexer, reconciliation, KYC/bank mocks."),
    ("6", "Internal portals", "Not started", "Operations, compliance and trustee portals with maker-checker; enforce offboarding order (F-02)."),
    ("7", "Investor apps", "Not started", "Website, investor web portal, verification page, Flutter app."),
]


def build():
    story = []

    # Cover
    story.append(NextPageTemplate("content"))
    story.append(PageBreak())

    # Contents
    story += h1("Contents")
    toc = [
        "1. About this document",
        "2. Lifecycle at a glance",
        "3. Guiding principles",
        "4. Phases 0–8 in detail",
        "5. Development flow (Steps 1–7)",
        "6. Smart-contract lifecycle",
        "7. Engineering workflow",
        "8. Security standards by step",
        "9. What gets built",
        "10. Team and roles",
        "11. Findings and top risks",
        "12. Operations cadence",
        "13. Open decisions and next actions",
        "Appendix: Glossary",
    ]
    story += [P(t, "toc") for t in toc]
    story.append(Spacer(1, 10))
    story.append(
        callout(
            "<b>Current position (8 October 2026):</b> Phases 1 and 2 are complete. Phase 3 is in progress: Steps 1–3 are done "
            "internally, including all smart contracts with 120 passing tests and 100% coverage. The next step is Step 4, the local "
            "Besu chain. Nothing has been externally audited yet."
        )
    )
    story.append(PageBreak())

    # 1. About
    story += h1("1. About this document", "Purpose, audience and how to read the status markers.")
    story.append(
        P(
            "This document describes the complete lifecycle of the Property Token platform: a permissioned system for fractional "
            "ownership of real estate in Pakistan. An independent trustee holds each property; investors hold ERC-3643 security "
            "tokens that mirror the trustee's register; rent and investments move in PKR through banks. Smart contracts record "
            "ownership and entitlements only and never hold money."
        )
    )
    story.append(
        P(
            "It is written for the founders, the engineering team, the trustee, auditors and the regulator. It complements, and does "
            "not replace, the detailed documents in the repository: the contract specification, threat model, security standards "
            "baseline, product map and findings."
        )
    )
    story.append(P("Status markers used throughout:", "h3"))
    legend = Table(
        [[status_chip(s), Paragraph(d, S["cell"])] for s, d in [
            ("Done", "Gate passed."),
            ("Done (internal)", "Built and verified internally; external verification still pending."),
            ("In progress", "Work under way."),
            ("Next", "Approved to start after the current gate."),
            ("Not started", "Planned."),
        ]],
        colWidths=[0.22 * CONTENT_W, 0.78 * CONTENT_W],
        style=TableStyle([("VALIGN", (0, 0), (-1, -1), "MIDDLE"), ("BOTTOMPADDING", (0, 0), (-1, -1), 3)]),
        hAlign="LEFT",
    )
    story.append(legend)
    story.append(Spacer(1, 6))
    story.append(
        P(
            "Source of truth: when this PDF and the repository disagree, the repository wins. Regenerate this file with "
            "<font name='Mono'>python docs/tools/build_lifecycle_pdf.py</font> after updating status."
        )
    )

    # 2. At a glance
    story.append(PageBreak())
    story += h1("2. Lifecycle at a glance", "Nine phases. Each ends with a gate that must pass before the next begins.")
    rows = [["Phase", "Name", "Duration", "Status"]]
    for ph in PHASES:
        rows.append([ph["n"], ph["name"], ph["time"], status_chip(ph["status"])])
    story.append(table(rows, [0.09, 0.5, 0.23, 0.18], bold_first_col=True, valign="MIDDLE"))
    story.append(Spacer(1, 8))
    story.append(
        callout(
            "<b>Total to launch: about 12–15 months.</b> In a security-first project, rushing is the single biggest risk. "
            "Phase 0 runs in parallel with Phases 1–3, but code that depends on the legal structure waits for its gate."
        )
    )
    story.append(Spacer(1, 10))
    story.append(P("Flow", "h3"))
    flow_cells = [Paragraph(f"<b>{p['n']}</b><br/>{p['name']}", ParagraphStyle(
        "flow", fontName="Body", fontSize=7.4, leading=9.4, textColor=INK, alignment=TA_CENTER)) for p in PHASES]
    flow = Table([flow_cells], colWidths=[CONTENT_W / 9] * 9, rowHeights=[46])
    fstyle = [
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BOX", (0, 0), (-1, -1), 0.5, RULE),
        ("INNERGRID", (0, 0), (-1, -1), 1.5, colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 2),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2),
    ]
    for i, p in enumerate(PHASES):
        fstyle.append(("BACKGROUND", (i, 0), (i, 0), STATUS_COLOURS[p["status"]][1]))
        fstyle.append(("LINEABOVE", (i, 0), (i, 0), 3, STATUS_COLOURS[p["status"]][0]))
    flow.setStyle(TableStyle(fstyle))
    story.append(flow)

    # 3. Principles
    story.append(Spacer(1, 14))
    story += h1("3. Guiding principles")
    principles = [
        ("Gates are not skipped.", "Deadline pressure never justifies passing a gate whose criteria are not met."),
        ("Spec first, then tests, then code.", "Behaviour changes start in the specification; every invariant has a named test."),
        ("No single failure loses investor money.", "Not one bug, one stolen key, one dishonest insider, or one company failing."),
        ("Contracts never hold money.", "PKR moves through banks; the chain records ownership and entitlements."),
        ("Reuse audited code; keep custom code small.", "ERC-3643 core is reused unchanged; our guards each expose one narrow power."),
        ("Every power is time-locked or multi-signed.", "72h timelock on all owners; Safes for every value-moving action."),
        ("No contract change after audit without re-audit.", "No exceptions, including 'small' fixes."),
        ("Separate keys per environment.", "Production keys live only on hardware (HSM/MPC, hardware wallets)."),
        ("Small pilot, gradual launch.", "Limits start low and rise only with evidence."),
    ]
    story.append(table([["Principle", "What it means in practice"]] + [[a, b] for a, b in principles], [0.38, 0.62], bold_first_col=True))

    # 4. Phases
    story.append(PageBreak())
    story += h1("4. Phases 0–8 in detail", "Objective, activities, deliverables, standards and exit gate for each phase.")
    for ph in PHASES:
        head = Table(
            [[
                Paragraph(f"Phase {ph['n']}", ParagraphStyle("pn", fontName="Body-Bold", fontSize=9, leading=12, textColor=TEAL)),
                Paragraph(ph["name"], ParagraphStyle("pt", fontName="Body-Bold", fontSize=12.5, leading=16, textColor=NAVY)),
                Paragraph(ph["time"], ParagraphStyle("pd", fontName="Body", fontSize=8.6, leading=12, textColor=MUTED)),
                status_chip(ph["status"]),
            ]],
            colWidths=[0.11 * CONTENT_W, 0.47 * CONTENT_W, 0.24 * CONTENT_W, 0.18 * CONTENT_W],
            style=TableStyle([
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LINEBELOW", (0, 0), (-1, 0), 1.2, NAVY),
                ("LEFTPADDING", (0, 0), (-1, -1), 2),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]),
        )
        body = table(
            [
                ["Objective", ph["objective"]],
                ["Key activities", "<br/>".join(f"• {a}" for a in ph["activities"])],
                ["Deliverables", ph["deliverables"]],
                ["Standards", ph["standards"]],
                ["Exit gate", f"<b>{ph['gate']}</b>"],
            ],
            [0.2, 0.8],
            header=False,
            bold_first_col=True,
        )
        story.append(CondPageBreak(70 * mm))
        story.append(KeepTogether([head, Spacer(1, 3), body, Spacer(1, 12)]))

    # 5. Development flow
    story.append(PageBreak())
    story += h1("5. Development flow (Steps 1–7)", "Phase 3 broken into seven steps, each with its own review gate.")
    rows = [["Step", "Scope", "Status", "Delivered / planned"]]
    for n, scope, st, detail in STEPS:
        rows.append([n, scope, status_chip(st), detail])
    story.append(table(rows, [0.07, 0.24, 0.17, 0.52], bold_first_col=True))
    story.append(Spacer(1, 10))
    story.append(P("Step 3 results (smart contracts)", "h2"))
    metrics = [
        ["Check", "Result"],
        ["Tests (unit, fuzz, invariant)", "<b>120 / 120 passing</b>; invariant campaign of 25,600 random calls, 0 violations"],
        ["Coverage of our contracts", "<b>100%</b> lines, statements, branches and functions"],
        ["Static analysis", "Slither 0.11.6: <b>0 results</b>; forge lint: 0 warnings; formatting enforced"],
        ["Documentation", "NatSpec on every external and public function"],
        ["EthTrust", "[Q] self-assessment against the v3 draft: all Met or N/A except one exception and one partial for the auditor"],
        ["Deployment", "Single DeployLib used by tests and production; deployed to Anvil and verified on-chain with cast"],
        ["Contract sizes", "Largest 3.7 KB of the 24 KB limit (small code is easier to audit)"],
    ]
    story.append(table(metrics, [0.32, 0.68], bold_first_col=True))
    story.append(Spacer(1, 8))
    story.append(callout("Internal results only. Formal verification and two external audits are required before mainnet.", "warn"))

    # 6. Smart-contract lifecycle
    story.append(PageBreak())
    story += h1("6. Smart-contract lifecycle", "The path every contract change follows, from idea to production and beyond.")
    sc = [
        ["#", "Stage", "What happens", "Evidence"],
        ["1", "Specify", "Behaviour, roles, limits and invariants written in docs/contract-spec.md.", "Spec diff in the PR"],
        ["2", "Test first", "Unit, fuzz and invariant tests for every new rule.", "Named tests per invariant"],
        ["3", "Implement", "Smallest possible code; reuse audited libraries; checks-effects-interactions; events before calls.", "Code review by a senior Solidity reviewer"],
        ["4", "Analyse", "forge fmt, forge lint, Slither; 100% coverage target.", "CI green"],
        ["5", "Verify formally", "Core invariants proven with Certora or Halmos.", "Verification report"],
        ["6", "Freeze and audit", "Code freeze; two independent audits; fix review.", "Published reports"],
        ["7", "Deploy", "Only through script/DeployLib.sol; checkHandover asserts I-8 and I-9.", "Deployment record"],
        ["8", "Verify bytecode", "Deployed bytecode matched to the audited commit; deployer key destroyed.", "Verification log"],
        ["9", "Go live", "Timelock sets the trustee cap after 72h; Admin Safe unpauses (tokens deploy paused).", "Timelock operation IDs"],
        ["10", "Operate and upgrade", "Upgrades only via proposal → audit → 72h timelock → public notice → multisig.", "Change log"],
    ]
    story.append(table(sc, [0.05, 0.17, 0.53, 0.25], bold_first_col=True))
    story.append(Spacer(1, 10))
    story.append(P("Deployment hand-over checklist (enforced by DeployLib.checkHandover)", "h3"))
    story += bullets([
        "Every owner is the 72h TimelockController: token, registries, compliance, factory, both implementation authorities, both modules, all guards.",
        "Deployer has no timelock admin or proposer role; Trustee Safe holds the canceller role.",
        "Only the four guards are token agents; the timelock is never a token agent.",
        "Claim issuer managed by the manager key, not the deployer; claim signer registered.",
        "Both compliance modules bound; token still paused until go-live.",
    ])

    # 7. Engineering workflow
    story.append(PageBreak())
    story += h1("7. Engineering workflow", "Environments, branching, pull requests and the CI pipeline.")
    story.append(P("Environments", "h2"))
    env = [
        ["Environment", "Chain", "Keys", "Data"],
        ["Local", "Anvil", "Public test accounts", "Synthetic"],
        ["Dev", "Private Besu", "Software keys, dev-only", "Synthetic"],
        ["Staging", "Besu, production-like", "Separate HSM partition", "Anonymised"],
        ["Production", "Besu, 4 organisations + public anchor", "HSM/MPC, hardware-wallet Safes", "Real; never copied down"],
    ]
    story.append(table(env, [0.18, 0.3, 0.3, 0.22], bold_first_col=True))
    story.append(P("Branching and pull requests", "h2"))
    story += bullets([
        "<b>main</b> is protected: pull request required, two approvals, CI required, signed commits.",
        "One feature per branch; small pull requests; the PR template carries the security definition of done.",
        "No new dependency without written justification; dependencies pinned to exact versions or tags.",
        "No secrets, keys or personal data in code, logs or fixtures; .env files are never committed.",
    ])
    story.append(P("Security definition of done (every pull request)", "h2"))
    dod = [
        "Spec or ADR updated if behaviour changed",
        "Threat model updated for any new asset, flow or trust boundary",
        "Tests written, including failure and abuse cases",
        "CI green: tests, coverage, static analysis, secret scan, dependency scan",
        "No unjustified new dependency",
        "No secrets or personal data",
        "Two approvals (contracts: one senior Solidity reviewer)",
        "Signed commits",
    ]
    story.append(table([["", "Requirement"]] + [["<font name='Symbol2' size='11'>☐</font>", d] for d in dod], [0.06, 0.94]))
    story.append(P("CI pipeline", "h2"))
    story.append(table(
        [["Stage", "Tooling", "Fails the build when"],
         ["Secret scan", "gitleaks", "Any secret pattern is found"],
         ["Format and lint", "forge fmt --check, forge lint", "Formatting differs or a lint fires"],
         ["Build and test", "forge build --sizes, forge test", "Any test fails or a contract exceeds size limits"],
         ["Coverage", "forge coverage", "Coverage falls below target"],
         ["Static analysis", "Slither", "Any high-severity finding"]],
        [0.2, 0.38, 0.42], bold_first_col=True))

    # 8. Standards by step
    story.append(PageBreak())
    story += h1("8. Security standards by step", "A gate cannot pass until its standards are met and the evidence is in the repository.")
    std = [
        ["Step / phase", "Standards that must be met at the gate"],
        ["1 Repo and CI", "NIST SSDF (PO, PS), OpenSSF Scorecard, secret scanning"],
        ["2 Specs", "Complete STRIDE threat model; NIST CSF risk mapping"],
        ["3 Contracts", "EthTrust [Q] self-assessment, OWASP SCSVS, Smart Contract Top 10, 100% branch coverage on guards, invariants passing, Slither clean"],
        ["4 Chain", "CIS Benchmarks on nodes, TLS between nodes, node allow-list"],
        ["5 Backend", "OWASP ASVS L3, API Security Top 10, NIST 800-63B, CCSS III design for the signing service"],
        ["6 Internal portals", "OWASP ASVS L3; AAL3 staff authentication (FIDO2 hardware keys)"],
        ["7 Mobile app", "OWASP MASVS L2 + RESILIENCE"],
        ["Pre-launch", "Two contract audits, external pen test, SLSA L3, CIS IG3, ISO 27001 and SOC 2 programmes started"],
    ]
    story.append(table(std, [0.25, 0.75], bold_first_col=True))
    story.append(Spacer(1, 10))
    story.append(P("Full baseline", "h3"))
    story.append(table(
        [["Area", "Standard", "Target"],
         ["Smart contracts", "EEA EthTrust Security Levels, OWASP SCSVS", "Level [Q]"],
         ["Web and APIs", "OWASP ASVS 5.0, API Security Top 10", "Level 3"],
         ["Authentication", "NIST SP 800-63B", "AAL2 investors, AAL3 staff"],
         ["Mobile", "OWASP MASVS 2", "L2 + RESILIENCE"],
         ["Keys and custody", "CCSS, FIPS 140-3, NIST SP 800-57", "CCSS III, HSM Level 3"],
         ["Supply chain", "NIST SSDF, SLSA, OpenSSF Scorecard, OWASP SAMM", "SLSA Build L3"],
         ["Infrastructure", "CIS Benchmarks, CIS Controls v8", "IG3"],
         ["Organisation", "ISO 27001, SOC 2 Type II, ISO 27701, NIST CSF 2.0", "Certification before public launch"],
         ["Compliance", "FATF, AML Act 2010, SECP/PVARA, PECA 2016", "Mandatory"]],
        [0.2, 0.5, 0.3], bold_first_col=True))

    # 9. What gets built
    story.append(PageBreak())
    story += h1("9. What gets built", "Websites, portals, apps and services (full detail in docs/product-map.md).")
    story.append(table(
        [["#", "Product", "Users", "Phase"],
         ["1", "Public website", "Everyone", "Pilot"],
         ["2", "Investor web portal", "Investors", "Pilot"],
         ["3", "Investor mobile app (Android, iOS)", "Investors", "Pilot"],
         ["4", "Public verification page", "Anyone", "Pilot"],
         ["5", "Operations / admin portal", "Operations staff", "Pilot"],
         ["6", "Compliance portal", "Compliance officer", "Pilot"],
         ["7", "Trustee portal", "Trustee officers", "Pilot"],
         ["8", "Multisig signing console", "Safe signers", "Pilot"],
         ["9", "Property sponsor portal", "Property owners", "Later"],
         ["10", "Secondary market", "Investors", "After regulatory approval"]],
        [0.06, 0.46, 0.28, 0.2], bold_first_col=True))
    story.append(Spacer(1, 8))
    story.append(P("Backend services", "h3"))
    story.append(P(
        "API gateway · Auth (passkeys, device binding) · Ledger (double-entry, append-only, hash-chained) · Signing service "
        "(HSM/MPC, policy engine) · Indexer · Reconciliation (chain vs ledger vs bank) · KYC (NADRA Verisys, liveness, "
        "sanctions/PEP) · Payments (bank, Raast) · Notifications · Document store · Anchor job · Monitoring."
    ))
    story.append(P("Blockchain layer", "h3"))
    story.append(P(
        "ERC-3643 token suite with our guard contracts (built), private Besu QBFT network with four validators run by "
        "separate organisations (Step 4), and an hourly public-chain anchor (built; network choice pending)."
    ))

    # 10. Team
    story.append(Spacer(1, 6))
    story += h1("10. Team and roles")
    story.append(table(
        [["Role", "Count", "Responsibility"],
         ["Senior Solidity / blockchain engineer", "1–2", "Contracts, chain, audits liaison"],
         ["Backend engineers", "2", "Services, ledger, signing service, integrations"],
         ["Flutter / web developers", "1–2", "Investor apps, website, portals"],
         ["DevOps / security engineer", "1", "Infrastructure, CI/CD, monitoring, key management"],
         ["QA engineer", "1", "Test plans, end-to-end and failure testing"],
         ["Product manager", "1", "Requirements, gates, stakeholder alignment"],
         ["Compliance officer", "1", "KYC/AML, FMU reporting, regulator liaison"],
         ["External: auditors, pen testers, lawyer, Shariah advisor, trustee", "Contract", "Independent assurance and legal structure"]],
        [0.42, 0.12, 0.46], bold_first_col=True))

    # 11. Findings
    story.append(PageBreak())
    story += h1("11. Findings and top risks", "Found during Step 3. All three are in vendored code; each has a tested mitigation.")
    story.append(table(
        [["ID", "Issue", "Mitigation", "Status"],
         ["F-01", "ONCHAINID claim revocation can be bypassed by re-encoding the old signature; a revoked investor becomes verified again.",
          "Never rely on revocation. Offboarding: freeze immediately → move or redeem tokens → delete identity through the timelock.", "Mitigated, tested"],
         ["F-02", "MaxBalanceModule strands tokens if a holder's identity is deleted or updated.",
          "Same offboarding order; never update a holding wallet's identity; admin portal enforces; invariant I-17.", "Mitigated, tested"],
         ["F-03", "ONCHAINID claim signatures do not include chainid (cross-chain replay).",
          "One claim-signer key per chain.", "Mitigated by design"]],
        [0.08, 0.37, 0.4, 0.15], bold_first_col=True))
    story.append(Spacer(1, 10))
    story.append(P("Top risks to address first", "h3"))
    story.append(table(
        [["Risk", "Why it matters", "Planned control"],
         ["Key compromise (K-1 to K-3)", "Whoever holds keys controls ownership records", "HSM/MPC signing service with policy engine, multisig, rotation drills"],
         ["Contract bugs (SC-1, SC-2)", "Could mint or move tokens", "Tests, formal verification, two audits"],
         ["Payout redirection (M-1)", "Most common real-world fraud", "IBAN title match to CNIC, 72h cooling-off on bank changes"],
         ["SIM swap (API-2)", "Common in Pakistan", "Passkeys or authenticator app from the first release"]],
        [0.25, 0.33, 0.42], bold_first_col=True))

    # 12. Operations cadence
    story.append(Spacer(1, 6))
    story += h1("12. Operations cadence")
    story.append(table(
        [["Frequency", "Activity"],
         ["Daily", "Three-way reconciliation (chain, ledger, bank); payouts freeze on mismatch"],
         ["Weekly", "Alert review; dependency updates"],
         ["Monthly", "Access review: who holds what, and is it still needed"],
         ["Quarterly", "Key-rotation drill; disaster-recovery restore drill"],
         ["Every 6 months", "External penetration test; standards baseline review"],
         ["Yearly", "Red-team exercise; full security audit; certification audits (ISO 27001, SOC 2)"],
         ["Every upgrade", "Proposal → audit → 72h timelock → public notice → multisig execution"]],
        [0.2, 0.8], bold_first_col=True))

    # 13. Open decisions
    story.append(PageBreak())
    story += h1("13. Open decisions and next actions")
    story.append(P("Decisions for the owner", "h2"))
    story.append(table(
        [["#", "Decision", "Needed by"],
         ["1", "ERC-3643 is GPL-3.0: legal opinion on our deployment and distribution model", "Before mainnet"],
         ["2", "Public anchor chain: Ethereum mainnet (most trusted, costly) or an L2 such as Base or Polygon (cheap)", "Step 5"],
         ["3", "Auditor rulings: single-key exception (pauser, registrar, anchor key); token-address validation in registries", "Phase 5"],
         ["4", "Retail investment limits", "Before pilot"]],
        [0.06, 0.74, 0.2], bold_first_col=True))
    story.append(P("Next actions", "h2"))
    story.append(table(
        [["#", "Action", "Owner"],
         ["1", "Step 4: 4-validator Besu QBFT network on Java 21; deploy via DeployLib; run flows against it", "Engineering"],
         ["2", "GitHub branch protection on main, Dependabot alerts, secret scanning", "Repository owner"],
         ["3", "Report F-01 to the ONCHAINID maintainers (responsible disclosure)", "Engineering"],
         ["4", "Shortlist two audit firms and a formal-verification provider", "Founders"],
         ["5", "Continue Phase 0: legal route, trustee, first property title checks", "Founders + counsel"]],
        [0.06, 0.7, 0.24], bold_first_col=True))

    # Glossary
    story.append(Spacer(1, 6))
    story += h1("Appendix: Glossary")
    gloss = [
        ("ERC-3643", "Ethereum standard for permissioned security tokens: only verified identities can hold or receive."),
        ("ONCHAINID", "On-chain identity contract per investor, carrying KYC and AML claims signed by a trusted issuer."),
        ("Guard contract", "Our small contract that holds exactly one token power (mint, pause, freeze, recovery, register) with limits."),
        ("TimelockController", "Contract that delays privileged actions (72h) so they are visible and can be cancelled."),
        ("Safe (multisig)", "Wallet that needs several signers (e.g. 3-of-5) to approve a transaction."),
        ("Besu QBFT", "Permissioned Ethereum client with a consensus that gives immediate finality (no re-orgs)."),
        ("State anchor", "Hourly hash of the private chain written to a public chain, making history rewrites detectable."),
        ("Merkle root", "Single hash committing to every investor's rent entitlement; each investor can verify their own share."),
        ("Maker-checker", "One person prepares an action, a different person approves it."),
        ("HSM / MPC", "Hardware security module / multi-party computation: ways to use keys without exposing them."),
        ("Trustee register", "The trustee's official record of units; total token supply can never exceed it."),
        ("KYC / AML", "Know Your Customer identity checks / Anti-Money Laundering controls."),
        ("SECP, PVARA, FMU, CDC", "Securities regulator; virtual-assets regulator; Financial Monitoring Unit; Central Depository Company."),
    ]
    story.append(table([["Term", "Meaning"]] + [[a, b] for a, b in gloss], [0.24, 0.76], bold_first_col=True))
    return story


def main():
    doc = BaseDocTemplate(
        str(OUT),
        pagesize=A4,
        leftMargin=18 * mm,
        rightMargin=18 * mm,
        topMargin=20 * mm,
        bottomMargin=18 * mm,
        title="Development Lifecycle",
        author="Property Token engineering",
        subject="Complete development lifecycle: phases, gates, standards and status",
        creator="docs/tools/build_lifecycle_pdf.py",
    )
    full = Frame(0, 0, A4[0], A4[1], id="cover", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    content = Frame(doc.leftMargin, doc.bottomMargin, doc.width, doc.height, id="content")
    doc.addPageTemplates([
        PageTemplate(id="cover", frames=[full], onPage=draw_cover),
        PageTemplate(id="content", frames=[content], onPage=draw_page),
    ])
    doc.build(build())
    print(f"Wrote {OUT}")


if __name__ == "__main__":
    main()
