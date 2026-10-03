# 设计裁决 v2

唯一浏览器底座Playwright（Apache-2.0）；浏览器Agent高星参考只借受限动作/观测闭环，不堆browser-use、Skyvern、编排框架。TS/Node22、node:sqlite本地；Cloudflare D1云端。纯函数有限状态转移+带版本CAS存储，权限由服务端确定。

本地Node server+Playwright Chromium；生产Browser Worker+@cloudflare/playwright，前端Pages GitIntegration+Functions service binding。浏览器page.goto使用公开HTTPS旧后台（绑定短期capability），不是service binding地址。生产Free额度及CPU须现场门禁；绝不自动升级。

API规范见src/contracts.ts；统一{ok:true,data} / {ok:false,error:{code,message}}，所有mutation需CSRF与签名session。客户端只能看本session租户。历史synthetic数据留于隔离租户。

Plan{requestId,item,department,quantity,reason,source}; Run{id,revision,plan,planHash,targetRevision,adapterVersion,status,effectStatus,approvedHash,approvalExpiresAt,executionKey,events,result}; status=draft|approved|executing|unknown|verified|blocked|cancelled；effectStatus=none|unknown|applied。

执行API先CAS把approved→executing与执行key持久化，再开浏览器。旧后台POST验证execution capability+原批准+revision+payload+targetRevision；在DB唯一事务内写需求与effect。多进程同租户同requestId只允许一条需求。异常后核对原key，不生成新操作key。浏览器允许read/formSubmit固定动作，无eval模型文本，无任意网络。

人工approve是单独operator endpoint；planner/browser capability不能调用approve。计划改版清批准，取消先检查持久effect，已写仍可核对。UNKNOWN/崩溃后resume仅查结果，不盲目submit。

测试只写合成后台。公开应用不宣称已经集成真实企业客户；具备可运行的受控配置/登记/核对闭环。
