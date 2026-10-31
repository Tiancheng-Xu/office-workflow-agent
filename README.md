# Office Workflow Agent

Web2 办公流程 Agent：自然语言提出合成采购计划，用户确认后通过隔离 Chromium 登记旧网页表单，再用 API 核对真实后台记录。

已实现本地 Node/SQLite/Playwright 工作台、有限提案、租户隔离、并发认领与故障恢复。支持同一需求修订、字段差异和旧批准失效；浏览器观察、后台持久效果与独立 API 核对分别留证。2026-10-04 基础历史版本通过64项测试、36项独立浏览器验收及Spec/Standards复审，后续完成Worker/Pages、远端CI与生产业务回读。2026-10-08 自然语言扩展本地通过71项单元/集成与59项网页验收；新版本独立审查、远端CI、预览及生产回读分别留证。

输入例子：`前台买一台打印机`、`打印机一台给前台`或`研发需要两台屏幕`。应用提取和归一字段，自动生成稳定REQ编号；缺项保留已识别值并逐项补全。执行目录集中定义在`src/catalog.ts`：研发部、运营部、行政部、前台；显示器、键盘、办公椅、打印机；数量1–100。结构完整才生成未批准草稿；仍逐条人工确认与登记。重复相同无编号需求需明确不同编号才能作为独立采购；不确定响应换行或改等价说法仍先查询原编号。不连接真实客户系统、个人浏览器或付款流程。默认规则提案诚实标记来源；`PLANNER_MODE=ollama` 可使用已经安装的 `qwen2.5-coder:7b-code`，结果仍需严格校验。云端模型默认关闭。

## 本地运行

需要 Node >=22.16、pnpm 11.17.0（使用此版本起提供的 SQLite backup API）。真实最低Node22.16已通过64项测试，独立完整浏览器验收使用Node24.20.0；远端CI另行验证。

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm start
```

打开 `http://127.0.0.1:4173/`；`/evidence/` 为项目工作证明。`DATA_DIR` 可指定独立合成数据库目录，默认 `work/data/`；`PORT` 可改本地端口。本地生成持久密钥并只监听 localhost，生产必须设置独立 `SESSION_SECRET`。使用 CSR 工作台，不宣称 SSR。

```sh
pnpm typecheck
pnpm exec tsc -p tsconfig.cloud.json
pnpm test
pnpm test:e2e
pnpm audit
```

`scripts/evaluate-planner.ts` 对规则基线与实际本地模型使用相同的二十个冻结合成输入，不执行登记。当前两者均20/20，三个正常输入实际来自Ollama；不声称小样本证明泛化质量提升。`scripts/qa-crash.ts` 和 `scripts/qa-load.ts` 由独立 QA 在临时数据库与真实子进程中运行；不要指向生产数据库。

## 状态与证据

Agent-friendly 公开只读入口：[接口与安全说明](docs/agent-interface.md)，项目自定义清单 `/agent-capabilities.json`。仅查询公开项目和证明，不读取采购/会话/材料或执行动作；已验证发布版本、适配器检查与范围见[发布收据](public/evidence/agent-interface-verification.json)。原生 WebMCP 尚未验证。

结果不确定时只查询原需求编号，禁止自动重复提交。取消不会撤销已发生登记。数据库业务唯一键限制重复记录，产品不声称跨所有外部系统 exactly-once。

计划修订使用旧版本及内容 hash 做 CAS：保存 v2 会清除 v1 批准，固定需求编号和稳定业务键。执行中、效果不确定或已登记时禁止修订。报告每次重新查询实际后台字段；提交后丢失页面回执仍可由 API 验收。命中已有需求时如没有本次浏览器证据，界面明确标记缺失。报告 SHA-256 是完整性校验值，不是密码学签名或不可篡改存储。

- 需求与合同：`specs/office-agent/`。
- 架构和选型：`docs/architecture/`。
- 本地实际测试、崩溃恢复、备份恢复和负载：`docs/qa/`。
- 独立源码审查：`docs/review/`，修复后需要对当前文件哈希复审。
- 模型与后续部署收据：`docs/evidence/`。

计划部署为 Pages Git Integration + Pages Functions service binding + Browser Worker + D1，预览和生产已配置分别绑定独立 Worker/D1。Chrome 导航需要公开 HTTPS 旧后台。当前 `ENABLE_BROWSER_RUN=false`、`ENABLE_FREE_AI=false`；实际账户计划和共享额度未证实前保持关闭。CPU、TLS、部署 commit 与真实浏览器登记回读通过后，才更新生产完成状态。后续资源收据见 `docs/deployment/followup.json`。不存 Cloudflare token，不自动购买资源或升级套餐。

## 采购材料与外贸单据核对

`/materials.html` 支持文本、真实VTT时间码和结构化OCR结果导入，按来源定位字段并人工确认。采购人核只形成未批准草稿；外贸核对合同、订单和产品资料的数量、单位、币种、金额与交期，保存差异并导出核对包。租户案例、版本CAS及当前运行版本/哈希关联分别记录。

扫描识别与音视频转录引擎未接入；OCR合成样例不是识别准确率验收。使用范围、容量及恢复行为见 [资料核对说明](docs/materials-workspace.md) 与 [架构](docs/architecture/enterprise-materials-2026-10-11.md)。

## 可安装的采购与选材技能

在现有资料核对模块之外，`skills/` 提供两个独立的轻量入口（Python 3标准库，无模型依赖）：

- [询价变更复核](skills/tiancheng-rfq-change-review/SKILL.md)：对照规范化A/B/Q，检查旧值残留、单位/币种冲突与来源；仅输出未批准复核报告。
- [商品选材提案](skills/tiancheng-material-selection-brief/SKILL.md)：整理商品与材质双图引用、替换/保留要求及验收清单；不直接生图。

包内带合成输入与脚本真实输出。执行 `python3 tests/commercial-skills.test.py` 验证新增确定性逻辑；不代表平台模型实跑或企业流程验收。

通过 Skills CLI 可选择安装：`npx skills add Tiancheng-Xu/office-workflow-agent --skill tiancheng-rfq-change-review` 或将最后的名称改为 `tiancheng-material-selection-brief`。GitHub可安装与skills.sh榜单收录分别核验；不通过重复安装制造排名。WorkBuddy ZIP按当前官方格式由同一源码打包，安装/扫描/模型实跑/市场审核分别记录。各技能目录的MIT许可只适用于其新文件。
