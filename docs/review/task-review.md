# Independent task review — round 1

Record boundary (2026-10-06): the BLOCK findings, candidate source hashes and incomplete checks below are historical first-round evidence. They remain unchanged; they are not a current release verdict. The separate stable-input review allowed `89e72ed`, and the identical merge tree at `08cb4f0` received Oct4 CI and real synthetic production acceptance. See [release handoff](../deployment/README.md) and the [dated observation receipt](../deployment/release-observation-2026-10-06.json). The Oct6 observation only rechecks public HTTP and version metadata; it does not claim a new browser/business acceptance.

Verdict: **BLOCK**. Identity: Codex **gpt-6.1-sol / ultra**, independent subagent `/root/office_review`; reviewer is not an implementer. The transport exposes no provider request ID, so the JSON records null.

Contract hash: `c95f2b10da4e8a395b6bc45343a48439532dcf8f6458521d434cd01d519b7015`. Contract file SHA256: `982c37b2233b503fdd2d5a3664f3154b3466c3fa499cad9b7ad77b1483d0823f`. Every review input is pinned in `task-review.json`. This is a candidate review while implementation changes; final ALLOW must be a separately requested stable-input review.

## P1: Cancel can report none after a committed effect

`src/runtime/handler.ts:176–181`, input SHA256 `2e2c043ffb51c6a0486224c909562e9a5c5cd00bd1919a2b6c10758c7601ad97`.

Actual handler + SQLite reproduction: hold an approved execution after capability persistence; let cancel-check observe no demand; before returning that observation, submit the original authorized form through the real repository; then allow cancellation CAS. Observed: `cancelled / none`, `result` exists, demand count **1**. Only when the original executor later returns does its independent query restore `verified / applied`.

The cancellation branch handles only status verified and maps applied to none. A crash in this window leaves the committed demand represented as no effect, and the frontend hides the recovery action. Preserve the live applied effect inside the CAS transition and add this exact interleaving test.

## P2: Another tab's new session leaves old tenant records on refresh

`src/ui/main.ts:229–239`, input SHA256 `3e12c33773a3862644c5ef8482257e836c0b298eea816f1d6353315865516a1c`.

Actual isolated Chromium with current source: generate tenant A's draft; clear the synthetic cookie and establish tenant B through GET session, as another tab can do after expiry; verify tenant B's runs list is empty; refresh the original page. Observed: new session run count **0**, but both history and plan still show tenant A's demand. The server's CSRF gate protects writes; this is a client tenant-context and usability defect. The existing connect() reset does not run on a successful refresh. Add identity validation for refreshed records and a two-tab replacement test.

## Verification and boundaries

Local and cloud TypeScript checks pass. API/planner/D1-shim tests: **21/21 pass**. The browser unit runner hit a Node native assertion before product assertions; it is an infrastructure limitation, not an invented product finding. The isolated current-source Chromium scenario reproduced P2.

The D1 atomic-write and budget checks found no confirmed defect in the reviewed inputs. Cloudflare quota/CPU/real D1/production browser execution remain unverified; resources are not configured. No production success is claimed. The user's historical FDE experience is separate from this new project's evidence.

## P2: Finite planner changes partial business tokens

`src/planner.ts:11–18`, original SHA256 `71114afbc8163de7792779e975c8ce88d10e17ebff2148457b1121afc411a836`.

Actual original planner calls accepted **-12台 as 12**, **1.5台 as 5**, and a REQ suffix containing **49 A characters as only 48 A characters**. These outputs changed user-provided quantity or the stable demand key. Whole-token validation must reject unsupported signs, fractions and long IDs rather than repair them through substring extraction.

A targeted patch check at SHA256 `7a6942bb4881361ad3276a32ece79413510cc6992ced5e3cfea1bf5a62a140f6` confirms the original ASCII cases reject and the 48/49 character boundary is intact; fresh planner + D1 tests pass **11/11**. However, actual calls still accept **−12台 (U+2212)** and **－12台 (U+FF0D)** as positive **12**. The source hash was unchanged across that probe. This residual is recorded under finding 003 and remains pending a new gate.

## First-round closure

The original **BLOCK** and its finding inputs remain preserved. Root patches for findings 001 and 002 were observed/reported, and the 003 ASCII patch was partially checked; none is promoted to final acceptance here. Current Contract **v4**, hash `10352140f56ddbaa61a6b1b911657909b1519418aced1cfac1ca4476c78cfd28`, introduces revisions/diff and layered browser/API proof/digest/recovery, and requires a separate fresh-context stable-input review. Current closing hashes are appended to the JSON alongside the original manifest.

The browser test process was interrupted during permission-mode switching after four passing real-Chromium assertions. Its complete final result was unavailable; no full browser-suite success is claimed by this artifact. The earlier infrastructure failure remains recorded. The isolated two-tenant UI reproduction also confirmed CSRF rejection, zero backend effects, and removal of the old cache only after an explicit reconnect.
