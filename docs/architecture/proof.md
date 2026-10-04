# 合成采购执行证明

`src/runtime/proof.ts` 提供不访问存储、网络或浏览器的异步纯函数。使用已有 `canonicalPayload` 和 WebCrypto SHA-256，因此本地 Node 与 Cloudflare Worker 共用相同判断。

```ts
createExecutionProof(run: Run, observation: {
  checkedAt: string;
  queryStatus: 'found' | 'not-found' | 'unavailable';
  demand?: Demand;
}): Promise<ExecutionProof>

verifyExecutionProof(proof: unknown): Promise<boolean>
```

调用方先读取该租户、原 requestId 对应的最新需求。找到时传 `found` 和本次读取的 Demand；没有记录时传 `not-found`；读取失败时传 `unavailable`。`checkedAt` 必须是有效 ISO 时间。函数不自行取当前时间，不修改 Run，不将 `run.result` 当成本次查询结果。

报告 schema 为 `office-agent-execution-proof-v1`，`syntheticOnly` 为 true。

| 分层 | 固定输出 | 含义 |
| --- | --- | --- |
| run | id、revision、targetRevision、adapterVersion、持久 status/effectStatus、有限计划、planHash、executionKey | 已保存的运行快照；status 不代替当前 API 验收 |
| approval | status、approvedHash、expiresAt、hashMatches、validAtObservation | 批准 hash 与当前计划匹配，以及在观察时间是否仍有效 |
| browser | status、sameAttempt、evidence、statement | 本 Run 附带的实际 DOM、payload、POST 和 registered marker 观察 |
| database | effectStatus、hasPersistedResult、persistedResultMatchesPlan、result | 持久效果及已保存结果，不因本次查询故障或失配降级 |
| api | checkedAt、queryStatus、status、checks、demand、issues | 本次读取的 Demand 与 Run 独立比对 |
| allowedNextAction | approve、execute、query-only 或 none | 恢复界面的动作提示；服务器仍执行原授权与状态门禁 |
| digest | algorithm、value | 本报告 JSON 内容的 SHA-256 校验值 |

API `verified` 需要所有检查均为 true：requestId、department、item、quantity、reason 完全匹配；Demand 保存的 payloadHash 与 Run.planHash 相同；两份 canonical payload 的重算 hash 正确；executionKey 与 Run 完全相同。任意失配返回 `mismatch`。`found` 却缺少 Demand 返回 `unknown`；查询故障也返回 `unknown`，不复用旧结果冒充新验收。

浏览器 `postObserved` 只证明浏览器产生并被路由观察到 POST，不证明请求已通过 payload guard 或已被转发；`registeredMarker` 只证明页面出现预期标记。二者都不能推导事务已写或 API 已验收。`browser.status = observed` 表示附带证据的结构、来源、adapter 和 planHash 可归属于当前计划，也不表示动作成功。DOM 漂移等失败可以留下 `observed`、`domMatched = false` 的失败观察。没有 BrowserEvidence 时，evidence 为 null，statement 明确为 `no-browser-action-recorded-for-this-run`；读去重可独立 API 验收，不生成本次浏览器动作。

UNKNOWN、执行中、已知 applied、可能发生 POST、查询故障或 Demand 失配时，只允许 `query-only`。UNKNOWN 即使本次 `not-found`，也不允许重新写。取消且没有任何效果证据时返回 `none`；取消后已知 applied 仍保留效果并提示查询核对。

输出每层都重新构造白名单对象，不展开 Run、Demand、BrowserEvidence 或 observation 的未知属性。公开计划及需求只含合成业务字段；不输出 events/error 任意文本、旧 capability、token、cookie、storage 或原始表单。浏览器 origin 仅输出解析后的 HTTP(S) `URL.origin`，路径、query、fragment 和 userinfo 被移除；非法或不透明 URL 输出 null 并使浏览器证据 invalid。stopCode 仅保留已知固定代码，未知代码输出 `UNKNOWN_STOP`。

digest 的内容是**去掉根 digest 字段后的完整报告**，包括 generatedAt。规范化时递归按对象 key 的字典顺序排序，数组保留顺序；只接受普通 JSON 对象、数组、有限数字、字符串、布尔值与 null。按 UTF-8 编码后计算 SHA-256，value 为 64 位小写 hex。校验可发现相对于现有 digest 的内容修改，包含 browser receipt 或观察时间修改。

这个 digest 不是数字签名，也不证明发布者身份或防篡改存储。修改报告的人也能重算 digest；业务验收依赖最新 API 查询和服务器授权，不能依赖 checksum 自身。

`tests/proof.test.ts` 覆盖 canonical 字段/hash/key 失配、变更 payload、UNKNOWN 未找到、查询离线但持久 applied、无浏览器读去重、白名单去秘密、非法 origin，以及 receipt/时间/digest 改动检出。
