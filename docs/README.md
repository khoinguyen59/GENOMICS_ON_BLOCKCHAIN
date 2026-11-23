# GenoChain — Documentation Hub (`docs/`)

This index links strictly to verified documents and artifacts currently present on disk (zero dead links).

> **Academic Integrity Notice:** Uncommitted historical research notes (`docs/research/01..07`), legacy spreadsheets (`docs/reports/Rubik.xlsx`), prior reports (`docs/reports/03..06`), and legacy MP4/PNG recordings were permanently lost during the 2026-11-23 07:29 AM local profile wipe. Those items are intentionally omitted here rather than linked as broken references.

---

## 1. Specifications, Requirements & Rubrics (`docs/specs/` & `docs/requirements/`)

| Document | Scope | Link |
| :--- | :--- | :--- |
| **Project & Dataset Spec** | Course metadata (`IS355`, UIT), ports, tokenomics caps, 13 datasets & external audit references | [`project_spec.md`](requirements/project_spec.md) |
| **01. Academic Rubric (Scale A /40)** | Official course assignment specification across 4 criteria (`40/40` scale) | [`01_project_rubric.md`](specs/01_project_rubric.md) |
| **02. Technical Requirements** | Detailed functional decomposition, encryption pipeline, Escrow & EIP-2981 specification | [`02_technical_requirements.md`](specs/02_technical_requirements.md) |
| **03. Evaluation Checklist** | 26-item verification checklist, Web3 STLC & OWASP Smart Contract Top 10 (2026) RTM | [`03_evaluation_checklist.md`](specs/03_evaluation_checklist.md) |
| **04. Dataset Specifications** | Biological formats (`VCF`, `VCF.GZ`, `FASTQ`, `FASTA`, `BAM`, `Crypt4GH`) & benign cohort policy (`INV-11`) | [`04_dataset_specifications.md`](specs/04_dataset_specifications.md) |
| **05. Technical Architecture & Stack** | Layered architecture & component technology rationale | [`05_technical_architecture_and_stack_selection.md`](specs/05_technical_architecture_and_stack_selection.md) |
| **06. Enterprise Production Readiness Rubric (Scale B /40)** | 4-pillar (`40/40`) engineering & security readiness rubric with severity-band deductions | [`06_production_readiness_rubric.md`](specs/06_production_readiness_rubric.md) |

---

## 2. Empirical Evidence & Audit Reports (`docs/evidence/`, `docs/reports/`, `docs/audit_guides/`)

| Artifact | Format | Description | Link |
| :--- | :---: | :--- | :--- |
| **Master Audit & Architecture Report** | Markdown | Full 18-gate empirical verification ledger, EIP-170/3860 metrics & candid wipe disclosure | [`08_project_master_audit_and_architecture_report.md`](reports/08_project_master_audit_and_architecture_report.md) |
| **Verified Live Evidence Catalog** | Markdown + PNG | Inventory & SHA-256 digests of 22 fresh live-stack screenshots (`docs/evidence/live_screenshots/`) & 8 tracked README assets | [`evidence/README.md`](evidence/README.md) |
| **Slither Static Analysis Output** | JSON | Live Slither scan on `contracts/` (`0 High / 0 Medium` on production contracts) | [`slither_latest.json`](reports/slither_latest.json) |
| **Axe-Core WCAG 2.2 AA Report** | JSON | Live online accessibility audit (`34/34` scenarios, `0` blocking violations, `0px` overflow) | [`ui_ux_axe_report.json`](reports/ui_ux_axe_report.json) |
| **Independent AI Audit Prompt** | Markdown | Blind external reviewer guide | [`INDEPENDENT_AI_AUDIT_PROMPT.md`](audit_guides/INDEPENDENT_AI_AUDIT_PROMPT.md) |
| **Production VPS & Timelock Runbook** | Markdown | Base Sepolia / Sepolia deploy, `GenomicTimelock`, Private Kubo PNET, SIWE Gateway & Caddy TLS | [`DEPLOYMENT_RUNBOOK.md`](../deploy/DEPLOYMENT_RUNBOOK.md) |
