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

本期是隔离本地增量；本地测试、原项目整体验收、原生浏览器与生产发布分别核验。没有 token/CPU/延迟收益实测，不把 HTTP 只读接口混称 MCP/WebMCP。原业务流程、会话隔离、CSRF 和人工审批保持不变。
