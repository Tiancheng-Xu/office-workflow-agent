# 独立 QA 复现与证据

当前v4独立本地QA通过：**36/36端到端、64/64 unit/runtime/browser，0失败、0跳过**；typecheck/cloud typecheck/build均exit0。执行者为独立Codex Sol ultra QA，负责测试文件和QA报告，没有修改实现。冻结需求为 `specs/office-agent/contract.json` v4（声明的contractHash为 `10352140f56ddbaa61a6b1b911657909b1519418aced1cfac1ca4476c78cfd28`；报告另记录完整文件字节摘要）。所有操作只作用于临时SQLite和自有回环HTTP合成采购后台，不使用真实外站、真实账号或用户浏览器配置。

## 复现

本次明确使用 `/opt/homebrew/opt/node@24/bin/node`，版本 `v24.20.0`。已存在的 Chromium 为 `153.0.8010.12`，没有下载浏览器或模型。沙箱拒绝本地端口监听时会报 `listen EPERM`，应使用已经授予的本地 HTTP/Chromium 测试权限执行，不能把环境拒绝计为产品失败。

```sh
/opt/homebrew/opt/node@24/bin/node node_modules/vite/bin/vite.js build
/opt/homebrew/opt/node@24/bin/node node_modules/typescript/bin/tsc --noEmit
/opt/homebrew/opt/node@24/bin/node node_modules/@playwright/test/cli.js test
```

独立运维脚本也可以直接复现：

```sh
/opt/homebrew/opt/node@24/bin/node --import tsx scripts/qa-crash.ts
/opt/homebrew/opt/node@24/bin/node --import tsx scripts/qa-load.ts
```

测试强制 `PLANNER_MODE=rules`，用于确定性回归。真实模型小样本由另外的模型验证门禁提供。

当前QA配置为浏览器总预算10秒、故障门等待15秒、页面断言20秒、单例45秒；均写入机器收据。先前4秒QA预算在机器繁忙时于POST前安全停止，导致取消故障门未被实际演练，失败证据保存为 `browser-results-v4-4s-budget-failure.json` 和 `cancel-before-gate-timeout.json`。调整的是测试配置，不是实现的生产预算。

## 用例及断言

| 范围 | 实际行为与断言 |
| --- | --- |
| 正常前端业务 | 用户输入中文 → 预览 → 单独确认 → 点击执行；真实隔离 Chromium 读取旧页面、填字段、点击 submit；API 独立读核；SQLite 一条实际需求；报告无 token/cookie/CSRF 字段。 |
| 前端取消 | 草稿取消后零浏览器启动、零后台写入。 |
| 前端双击 | 实际双击确认及执行按钮，各只产生一条相应 API mutation、一个浏览器和一个真实表单 POST。 |
| 前端 UNKNOWN | 在真实表单 POST 丢失后，页面展示不确定结果；手动点击核对原需求，仅查询、不新发 POST。 |
| 会话轮转 | 旧租户已有缓存、选中计划、技术详情打开；真实 cookie 清除→401→点击重新连接→新签名会话空列表；旧批准/提案/列表三个实际 HTTP 回包迟到时，不得重新插入旧计划；新租户可以正常提案，详情默认关闭。 |
| 外部标签页换会话 | 旧页面保留A缓存，共享cookie的真实request context建立B并查B空；旧页面带A的X-OfficeFlow-Context刷新必须403 SESSION_CHANGED，重连前立刻清掉A缓存，再连接已存在的B且仍空。 |
| 租户隔离 | 第二个真实签名会话访问第一个运行的 report/approve/execute/cancel/reconcile 均 404；列表为空；篡改签名会话 401。 |
| CSRF/Origin | 缺失/错误 CSRF、错误 Origin 均 403；请求体选 tenant 被 strict schema 拒绝，零计划及效果。 |
| 批准约束 | 未批准不能执行；旧 revision 被拒；过期批准不启动浏览器。 |
| 修订闭环 | 实际 UI 将已批准的12改为15；同一运行 v2 展示真实字段差异、清除旧批准；旧批准和未重批执行均409且零浏览器；人工重新确认后，真实旧页面 submit15，SQLite/API 独立验收15。 |
| 修订并发与过期编辑 | 同一revision两个并发修订只能一个成功；旧版本不能覆盖；实际旧UI编辑器不能覆盖API已保存的新版本；executing/verified/UNKNOWN不可修订。 |
| 分层证明 | 实际HTTP导出的 ExecutionProof 分开观察浏览器POST/回执、持久业务效果及新API查询；正常和丢回执分别验收，DOM停止零POST；独立递归排序JSON和 SHA-256重算，篡改数量后校验失败，导出无会话及能力字段。摘要是内容校验，不是签名。 |
| 新查询和已有记录 | 实际SQLite字段变更后，报告API层mismatch；存储读故障后API层unknown/unavailable，保留DB applied，UI仅API层告警。实际UI新运行命中已有记录后只允许查询，确认结果后API verified但本次浏览器层无证据，零新POST。 |
| UNKNOWN恢复面板 | 实际不确定POST且无业务记录，浏览器层有POST、数据库层unknown、API层not-found并存；恢复面板只查询，重复execute/reconcile与报告读取均不新发POST。 |
| DOM 变化 | 改标签、重复输入、重复 submit 按钮、变更 form action 均停止，零表单 POST。 |
| 跳转 | 同源及跨源 302 均停止；目标是实际自有 HTTP trap，必须零命中、零效果。 |
| 并发 | 24 个并发 execute 同一个批准运行，一个真实 form POST、一条需求。 |
| 稳定键 | 两个独立批准运行使用同租户同需求编号并发登记，数据库仍一条；改数量的同 key 请求冲突。 |
| 目标变化 | 第一笔登记推进目标版本，第二个已批准旧目标在启动浏览器前被拒。 |
| 回执丢失 | 实际 legacy/submit 写入 SQLite 后断开响应，API 能核对原编号且重复 execute 不重写。 |
| 提交不确定且不存在 | 表单已由浏览器发出但未到业务事务；状态 UNKNOWN；后续 execute/reconcile 不启动新浏览器、不重写。 |
| 取消迟到 | POST 到事务前取消，零写；实际事务后取消保留 verified/applied，不撤销、不覆盖已发生效果。 |
| 取消 CAS 窗口 | cancel-check 先取得真实 SQL absent 快照，然后浏览器实际表单事务提交，回执继续暂扣；cancel 的 live CAS 不能把已持久化 applied 降为 none，必须重新核对或保留不确定的已发生效果。 |
| 真实进程崩溃 | 独立子进程运行真实 HTTP/SQLite/Chromium，在表单 POST 的事务前及事务后实际 SIGKILL；重新打开原数据库，先进入 UNKNOWN，execute 仅核对，零新浏览器/POST。 |
| SQLite 备份还原 | 在线 SQLite backup API → 新文件 restore → integrity_check=ok → 全部迁移版本及 resource_budget/window 行保留 → 原签名会话读核成功 → 重复 execute 不启动浏览器。 |
| 提案拒绝 | 13个真实API输入：缺字段、越权指令、中文/符号范围、算式、中文负词及minus/negative、汉字第二数量、非紧邻限定词；均需可操作的400改写提示，零浏览器与效果。独立记录矩阵分母，与模型冻结样本分开。 |
| 有分母负载 | 实际 `src/server.ts` 子进程及 SQLite；40 POST /api/propose（并发4）、120 GET /api/runs（并发8）、5次真实 Chromium业务闭环（并发1）；10个 warmup 明确排除。 |

## 结果文件

最终完整回归为 **36/36，63.655秒**。实现snapshot hash首尾一致：`39f218b7c594b5d15eed08005aaf84ea5d16c294379d4e5e37550276522a7835`；独立QA harness hash首尾一致：`74874572cb1d5e6ae6afc15b403e3ad5a866efabdac067f6a0c482b2177a8a6c`。生成最终gate时也已比对当前文件，两者仍一致。

真实SIGKILL恢复2/2、完整SQLite迁移/备份还原、13/13非法或歧义输入API400均通过。165个测量操作零错误，5/5真实Chromium业务核对成功。最终p95：提案API `4.308ms`（40个、并发4），读取API `3.446ms`（120个、并发8），完整浏览器业务 `443.615ms`（5个、并发1）。8份实际HTTP ExecutionProof均由QA自己的递归键排序及SHA-256重新校验，摘要全部一致。样本本地且有限，不宣称生产SLO达成。

`51863` 历史版本的完整执行为 **24/24 顶层用例通过、0失败，30.5秒**；两个真实进程崩溃点 **2/2通过**；负载测量 **165 个操作，0错误，5/5真实浏览器业务结果核对成功**。该轮整套代码 snapshot hash 首尾相同：`51863abf8d7ad623a9b4417c489fa239e3d8956950fd7817bf6de422221cfe9d`。对应本地 build/typecheck 均 exit 0。

随后独立 Review 发现取消 CAS 窗口 P1；独立真实浏览器用例已 RED 复现：数据库实际已有一条需求，而取消响应错误声明 `effectStatus:none`。会话轮转的三个实际页面用例已单独通过。旧24/24记录作为历史版本证据保留，不代表修复后的当前源代码。原回归扩展至29例，再加v4修订和恢复5例、新HTTP证明边界2例，当前完整分母为36。

v4首次完整执行35/36通过：已有记录的第二个提案被真实报告约束为query-only，UI正确隐藏确认/执行；QA用例错误等待确认按钮而超时。已根据实际页面与HTTP行为调整为点击核对原需求。另一轮4秒测试预算在提交前安全超时，取消故障门未被实际演练，35/36结果及持久证据均保留。随后独立复审修复planner歧义，QA调整测试预算并加入实际HTTP拒绝矩阵；最终冻结版本已如上重新全部通过。原始收据副本保留于忽略目录 `.tc-flow/archive/qa-history/`，公开收据仅将个人本机绝对路径改为repo-relative，不改变历史结论。

历史51863负载p95为提案 `3.753ms`、读取 `6.551ms`、完整业务 `595.101ms`，保留历史结论；没有把不同机器负载下的两轮样本当作性能改善证据。

- `independent-gate.json`：当前36/36最终门禁、双hash、用例分母、AC1–AC6及未验项；只给出本地QA verdict。
- `static-results.json` 和 `unit-output.txt`：实际typecheck/cloud typecheck/build命令、退出码及全部64个测试输出。
- `browser-results-51863-history.json` 和 `independent-gate-51863-history.json`：保留的历史稳定版本门禁。
- `cancel-cas-race-red-results.json`：取消 CAS 窗口的独立真实浏览器失败证据。
- `session-isolation-targeted-results.json` 及 `session-rotation-*.json`：三种实际迟到回包在新会话中被丢弃的页面证据。
- `browser-results.json`：当前整套测试结果、各用例耗时、命令、Node 可执行路径、Git 基线、实现 snapshot hash 与运行期间是否变化。
- `normal-flow.json` 和 `normal-workbench.png`：真实 UI 操作、旧页面 GET/POST 数量、实际结果、浏览器版本及截图。
- `revision-ui-proof.json` 和 `revision-proof-workbench.png`：已批准12→修改15的真实v2差异/批准撤销/重新批准/实际POST15/API验收15/导出摘要及篡改拒绝。
- `invalid-proposal-api-matrix.json`：13个真实HTTP非法/歧义输入的实际status及分母。
- `lost-receipt-layered-proof.json`、`unknown-proof-query-only.json`、`fresh-report-faults.json`、`deduplicated-proof.json`：真实HTTP证明，分别覆盖丢回执、UNKNOWN只查询、真实SQL字段漂移/读取故障、已有结果不伪造本次浏览器证据。
- `crash-results.json`：2 个实际 SIGKILL 点、恢复状态、原效果及重发次数。
- `sqlite-backup-restore.json`：实际备份/恢复与完整迁移表断言。
- `load-results.json`：165 个测量操作的逐条原始耗时/status/结果、每组分母与并发、p50/p95/max；其中5个业务样本包含会话/提案/确认准备耗时，不能与读 API 延迟直接比较。
- `browser-results-baseline.json`：修复前的真实浏览器基线；正常 POST 的 `Origin:null`、未捕捉的 route.fetch 故障和提案 500 失败保留，用于追踪实际修复。
- `browser-results-sandbox-denied.json`：环境 EPERM 拒绝的单独记录，不计为产品行为证据。

当前 `diffHash` 是按路径排序的 `src/`（包括cloud origin/worker和proof）、`migrations/`、package/lock/index/frozen contract、tsconfig及wrangler配置字节的 SHA-256；`sourceManifest` 保存实际文件路径，包含尚未被Git跟踪的实现文件，不是假称Git patch哈希。历史51863快照使用当时记录的较小manifest，其hashMethod随原报告保存。整套结果只有在 `implementationStableDuringRun=true` 时可作为冻结代码的最终本地QA门禁。后续代码变化应重新执行相应门禁。

## 边界

本QA worker完整实测Node24.20.0。父任务另在实际最低Node22.16.0执行64/64 unit/SQLite/Chromium，原收据为 `docs/evidence/node-minimum-verification.json`；QA只读取此独立来源并逐项比对其sourceHashes与当前代码一致，不假称自己执行Node22或Node22完整UI E2E。生产TLS、Pages/Worker/D1、线上真实浏览器业务回读、Cloudflare额度、模型样本和独立TC/Sol review由父任务另行验收。这里的有限样本不证明生产SLO、无限并发安全或exactly-once；UNKNOWN不会被写成成功。
