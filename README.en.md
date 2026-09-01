<div align="center">

# Voyage · 行舟

> *Smooth Sailing* · **潮平两岸阔，风正一帆悬**
> An AIOps platform that **democratizes operations** — plain language in, safe control out.

[![MIT License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Docs Audit](https://img.shields.io/badge/Docs%20Audit-100%2F100-brightgreen)](PRODUCT-DOC-AUDIT.md)
[![Security](https://img.shields.io/badge/Security%20RB%20Converged-%E2%9C%93-success)](AI红蓝对抗报告.md)
[![Tests](https://img.shields.io/badge/Tests-388-green)](impl/)

中文 | **[English](README.md)**

</div>

---

## About

**Voyage (xíng zhōu, "sailing vessel")** — an AIOps platform that **democratizes operations**: it understands plain language and safely commands systems.

- **One-line goal**: let SREs, developers, QA/PM, and managers complete queries and restricted operations **safely in natural language**.
- **Positioning**: while Agentic AIOps products serve on-call engineers, Voyage serves those who "dare not touch ops" — differentiation = **plain-language low barrier × zero-trust approval**.
- **Moat**: execution + trusted approval (query/QA layers are being commoditized by cloud vendors).
- **Five-layer architecture**: Perception (observability) → Decision (main agent) → Knowledge (RAG) → Execution (agent fleet) → Integration (unified gateway + zero trust).
- **Model-neutral**: cloud API first, local fallback, private deployment (sensitive data stays in-domain) — all configurable.

## Status

| Area | Status |
|------|--------|
| Docs (`docs/`, 9 files) | ✅ Final · audit 100/100 |
| Security red-blue | ✅ 10 rounds converged (96 fixes) |
| M0–M6 domain implementation | ✅ All landed (baseline/selection/DDD design + observability + conversation + trust + execution + integration/audit + beta walkthrough) |
| Real-deployment adapters | ✅ Audit persistence · identity/asset repositories · SSH managed-host execution · model access (multi-vendor) · auth (mTLS/WebAuthn/JWT) · composition root |
| End-to-end verification | ✅ Real chain verified: cloud intent → two-person approval → Grant → real SSH → audit trail |

## Layout

| Path | Content |
|------|---------|
| `docs/` | Product spec · requirements · 0-1 plan · metrics · AI eval strategy · DoD gate · personas · principles · roadmap (Chinese) |
| `impl/m0-*` – `impl/m6` | Milestone domain models with contract tests (zero-dependency pure JS + node:test) |
| `impl/m5/src/repo/` | Identity/asset file repositories + cloud-ledger projection |
| `impl/m5/src/exec/` | SSH managed-host execution adapter |
| `impl/m5/src/model/` | Vendor-neutral model layer + multi-vendor adapters |
| `impl/m5/src/auth/` | Auth adapter (mTLS / WebAuthn / JWT) |
| `impl/m5/src/compose.js` | Composition root (mock/real dual-mode assembly) |
| `impl/m6/ADAPTER-CONTRACTS.md` | Six real-adapter contracts |
| `AI红蓝对抗报告.md` | Ten-round red-blue security history (Chinese) |


## Development

```bash
# Full contract test suite (zero dependencies, Node ≥20, built-in node:test)
find impl -name "*.test.js" | xargs -I{} sh -c 'cd $(dirname {}); node --test $(basename {})'
# → 387 pass + 1 conditional skip (real-SSH E2E requires VOYAGE_E2E_REAL=1 + local private key)

# Real-mode end-to-end smoke (optional: needs ~/.ssh key + cloud server ledger)
VOYAGE_E2E_REAL=1 node --test impl/m5/test/e2e-real.test.js
```

## Git

Branch `main`; Conventional Commits.

## License

[MIT](LICENSE) © 2026 NinjaSln-labs
