# 缺口核验与官方参考（2026-10-03）

已回读50-面试/08、12、15、19及项目一资料。FDE业务需求→接口→验收已有用户经历/简历基线；浏览器不是已证明所有HC的明示必备，而是Web2客户系统缺少完整API时的集成建议。候选岗位快照不等于当前开放。

AM已有审批/账本/恢复；项目一已有MCP售后审批/幂等/UNKNOWN。新项目只补自然语言有限提案、DOM旧后台操作、网页与API核对、受控云浏览器执行，复用可靠性原则，不能把同一原则再算新增经历。Aladdin私有代码缺可授权入口，能力未知。用户“两年以上客户迭代，本人FDE”只标用户提供。

|官方仓库|实时stars|许可|维护push UTC|取舍|
|---|---:|---|---|---|
|https://github.com/browser-use/browser-use|117048|MIT|2026-10-03T00:06:08Z|Python Agent observation/action循环；模型及云浏览器单独收费，借结构不引入完整平台|
|https://github.com/microsoft/playwright|97040|Apache-2.0|2026-10-03T06:57:47Z|选择唯一TS浏览器底座；strict locator/actionability不是业务授权|
|https://github.com/Skyvern-AI/skyvern|23130|AGPL-3.0|2026-10-03T11:14:07Z|视觉/LLM工作流参考；不复制源码或引入平台|

来源：https://playwright.dev/docs/locators 、https://playwright.dev/docs/actionability 、https://github.com/browser-use/browser-use 、https://github.com/Skyvern-AI/skyvern 。stars只是实查快照不是质量/生产证明。

生产约束来源：https://developers.cloudflare.com/browser-run/limits/ 、https://developers.cloudflare.com/browser-run/playwright/ 、https://developers.cloudflare.com/pages/functions/bindings/ 、https://developers.cloudflare.com/workers-ai/platform/pricing/ 。Free浏览器10分钟/日/3并发，AI10000 neurons/日；当前账号计划/剩余额度和执行CPU尚待现场核验，不自动升级付费。
