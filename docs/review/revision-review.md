# Independent revision review — Contract v4

Verdict: **ALLOW for the pinned backend/planner/proof/cloud Spec and correctness/security scope**. Independent reviewer: Codex **gpt-6.1-sol / ultra**, `/root/office_revision_review`, fresh context (`fork_turns=none`), not an implementer. Actual spawn parameters were confirmed by the parent; provider request ID and UUID agent ID are unavailable. No source/test changes or commits were made by this reviewer.

Contract v4 hash: `10352140f56ddbaa61a6b1b911657909b1519418aced1cfac1ca4476c78cfd28`; complete contract file SHA256: `49dfe26fc961492b3e06b53231bbc8e4e68495130635fe0f7c9388114af5a602`. Baseline and HEAD: `f3f7ed2fb824e07bed51cfedd77089583a639f18`. Untracked implementation files are explicitly included. Final review input hash: `02ef862f5c66739fa1efe7e6c0ef8ea3248fc9a036e452c0eef572f48d431980`; source bundle hash: `64b4905a2f7ff2bb5112926f28f77fb1c5aa3dfb4528407189f558523ab78175`. The JSON records hash encodings, every file digest and all three rounds. Scoped files remained unchanged across final validation.

## Findings and repairs

**Round 1 BLOCK, P2 001:** real authenticated `/api/propose` accepted `12至13`, `12–13`, `12~13` as **13**, `12±1` as **1**, and `负的12` as positive **12**. Original planner SHA256 `1287568869f20dcdaa2d8dc3fb33145465ab879a43d1f2a768cdb0c5f1949d08`. Seven drafts; no browser launch or demand effect.

**Round 2 BLOCK, same P2:** the first repair rejected those inputs, but mixed ranges `十二台到13台`, `12台到十三台` and qualifiers `至少采购12台`, `约需12台` still became exact quantities. **P2 002:** explicit `取消`, `撤销` and `不要登记` also produced new registration drafts. Planner SHA256 `2e01b389e5092b3389f39174508289eae44cba991a3aa03a50c6829aba16d609`. These violate the requirements to use explicit values and ask for rewriting when input is ambiguous or unsupported. Human approval still gated all effects.

**Round 3 ALLOW:** at final planner SHA256 `32fd91c651a3e41f293b2646d03f86fc8535778075d892b5e71d70d6dc69c8b8`, all reported inputs return HTTP **400 `PLAN_UNSUPPORTED`** through the actual authenticated handler and planner. The 20 frozen evaluation cases pass **20/20**, additional attack cases **39/39**, boundary controls **6/6**. Valid 1, 12, spaced 12 and 100 quantities remain exact; 48-character ID suffix is preserved and 49 is rejected. Original expectations were not relaxed. No browser/model calls or demand effects occurred in these probes.

## Verified behavior

Scoped unit/API/SQL/proof suite: **54/54**, no skips. Local and cloud TypeScript checks pass. Real Chromium suite: **10/10**, covering guarded normal submit, DOM/action drift, redirect/popup/payload denial, disconnect after commit, escaping and deadline; these browser/runtime inputs remained byte-identical after the planner repairs.

The strict stale-absence → legal commit → cancel-CAS regression retains `applied`; fresh query failure also retains durable effect evidence. Valid cookie rotation rejects old context. Concurrent revision/execution uses one CAS winner; old approvals/capabilities are rejected, the request key stays fixed, and executing/UNKNOWN/completed/cancelled states cannot be revised. Proof checks every business field plus hashes and execution key against a fresh API result, retains database evidence separately, exports only a whitelist and labels digest as checksum. Cloud SQL rechecks actual time, while browser/AI remain disabled by default.

A read-only subaudit found no further P1/P2. Its local expiry check and in-memory worker switch check passed; the launch stub is explicitly not a cloud receipt. `task-review.json` and `.md` remain byte-identical to the preserved first-round originals.

## Boundaries

This ALLOW does not approve frontend/UI, whole-tree N7, Cloudflare quota/CPU/actual D1/Browser Worker, or production deployment. Reviewer commands used Node v24.20.0; root's separate Node 22 check is not relabeled as reviewer execution. The bounded cases establish regression behavior, not general model quality or unrestricted natural-language understanding. External acceptance gates remain with root.
