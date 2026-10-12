# Enterprise Materials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 实现采购与外贸两条资料核对流程，支持OCR分析结果、文本和真实VTT时间码消费，人核、租户案例、草稿关联和可校对报告。

**Architecture:** 共用来源证据类型，采购和外贸分析隔离。材料案例独立持久化，不扩采购Plan或执行权限。只用现有TypeScript/Zod/SQLite/D1/Playwright，无新模型或依赖。

**Tech Stack:** TypeScript、Zod、Vite、Node SQLite、D1、Playwright。

**Spec:** docs/architecture/enterprise-materials-2026-10-11.md。

## Global Constraints

- 原handler12KB/Node16KB不扩大；不新增真实ERP/邮件/付款写入。
- 所有材料为合成样本或人明确选择的合成材料，原件/源文不进入公开Evidence。
- 原propose仅{text}，原approve/execute/reconcile不改；当前部门、数量1–100与单位合同保持。
- OCR/ASR核心不复制；fixture和provider状态准确，VTT导入不称ASR已运行。
- 当前worktree保留node_modules符号链接；使用已有二进制，禁止pnpm自动清共享依赖。
- 不自动提交、push、部署或新建资源；先完成独立审查与本地验收。

## Review Focus

- OCR自报原件哈希与实际本机匹配分开，不把匹配当识别正确。
- VTT合法重叠cue不能误判；坏时间、远端样式/HTML不能执行。
- 人工补充或改值必须理由，旧revision不能覆盖现场case。
- 不用货币符号/模糊日期猜币种日期，不用浮点丢精度。
- 来源关联只对同租户与当前revision/planHash成立，换计划须stale。

### Task 1: Sources

Files: src/materials/sources.ts, tests/material-sources.test.ts。共同类型types.ts由主agent冻结。

- [x] 写WebVTT时间码、BOM/标识/设置/NOTE/STYLE、多行/重叠、恶意markup、OCR页/bbox/hash、容量负例。
- [x] 先RED；实现importTextSource/importVttSource/importOcrSource/validateMaterialSource，保持span引用及import哈希。
- [x] GREEN并保存实际命令，不改采购/API/其他agent文件。

### Task 2: Review and procurement/trade mapping

Files: src/materials/review.ts, tests/material-review.test.ts。

- [x] 写缺项、人补理由、冲突、中文/型号/包装、贸易币种/日期/精确金额负例。
- [x] 先RED；实现extractCandidates/reviewMaterials/procurementDraft，候选ID与字段引用稳定，来源不授予执行权。
- [x] GREEN；严格采购字段、固定reason；贸易输出consistent/needs-review/reviewed-with-issues。

### Task 3: Tenant case ledger

Files: migrations/004_material_cases.sql, src/materials/service.ts, src/runtime/repository.ts/sqlite.ts/handler.ts, src/cloud/repository.ts, tests/material-runtime.test.ts。

- [x] 写租户/CSRF/旧revision/链接不符/报告stale/请求体上限与零执行负例。
- [x] 先RED；增加material case create/read/list/CAS；handler既有认证后转给material service，不改原业务体。
- [x] GREEN；报告新鲜检查run revision/hash，digest非签名。

### Task 4: Workspace, fixtures and E2E

Files: materials.html, vite.config.ts, src/ui/materials.ts/materials.css, src/ui/main.ts导航, tests/e2e/materials.spec.ts。

- [x] 先写UI E2E：采购VTT→人核→保存→仅draft，贸易差异→人核→报告→刷新，OCR夹具显示原页区域、缺依赖准确提示，移动/注入。
- [x] 实现独立页面、导入来源/原件hash、字段选择/修改理由、会话保存/恢复、显式草稿创建和报告下载。
- [x] 独立审查ALLOW后应用/云类型、构建、单元与完整E2E；修复BLOCK复审。
- [x] 保存本地收据，更新PRD新增能力状态，保留旧生产截止与真实OCR/ASR待验。

## 本地验收回收

两轴独审ALLOW。147/147单元集成；77个浏览器用例首轮76通过，旧迁移数量断言修正后剩余1个定向通过；新增14材料用例最终独立14/14。应用/云类型、构建、Worker dry-run与完整依赖审计通过。旧39份冻结收据经SHA-256确认保持不变；新观测另存。后续提交、PR、预览与生产按既有Contract授权独立执行并留证，不将本地通过当生产通过。
