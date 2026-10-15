# OfficeFlow Agent-friendly interface

两项实验性浏览器只读工具只返回公开项目说明与 Evidence 入口：`of_project_info({projectId})`、`of_project_evidence({projectId,limit?,cursor?})`。projectId 为 `office-workflow-agent`；分页默认3/最大5，最多6144 UTF-8 bytes，只有一项公开证明因此不产生下一页游标。

输入再次 strict 校验；role、tenant、token、任意 URL 和附加字段拒绝。工具不读取当前采购/执行记录、会话、材料正文或私有 workspace，不访问API或模型，不发起审批/执行/修改/采购。`readOnlyHint` 不代替真实授权。

`document.modelContext` 不支持则不注册；AbortSignal 只绑定自己的工具，页面退出释放，浏览器缓存恢复后仅重新挂载这两项公开查询，不重启业务页面。不按名字删除外部注册，不跨源放权。输出显式挑选公开字段和已审核的同源 Evidence，来源对象即使混入额外字段也不透传。`/agent-capabilities.json` 为项目自定义清单，不是标准指定地址或原生验收证明。

```sh
pnpm exec tsx --test tests/agent-interface.test.ts
pnpm typecheck
pnpm test
pnpm build
```

PR #12 已合并并发布，已验证版本为 `6290c4f9ccf6d6d4a5e5f0df77126179284f6efa`，正式 Pages 部署为 `ba1206fa-7386-494f-b6df-a50a3b7041dc`。规范预览、生产域名、产物字节、TLS、只读健康检查及1440/390页面分别回读；完整范围见[公开发布收据](../public/evidence/agent-interface-verification.json)。清单的发布状态引用这份已验证版本快照，不代表后续提交自动通过验收。

本地152项单元测试和79项原有网页测试按相同源码复用；新增20项针对性检查使用明确模拟的 document.modelContext。真实隔离浏览器未提供该API，因此原生 WebMCP 与真实 bfcache 往返仍未验证。未执行新增采购登记，也没有 token/CPU/延迟收益实测。原业务流程、会话隔离、CSRF 和人工审批保持不变。
