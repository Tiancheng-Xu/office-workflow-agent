# GitHub 同类实现与本次产品取舍

2026-10-08 实查官方仓库/文档，不以 star 数量判断质量，未克隆、复制代码或安装完整平台。

|实现与官方出处|实际机制|本项目缺口与落地|
|---|---|---|
|[Activepieces](https://github.com/activepieces/activepieces#-why-activepieces-is-different)|README 列出人工审批、延迟节点以及 Chat/Form 人工输入接口。|自然语言缺项难补、只支持单条。增加结构化字段追加与批量逐行预检；每条仍在原面板批准与执行。|
|[Skyvern](https://github.com/Skyvern-AI/skyvern#skyvern-workflows)|任务可指定结构化数据和停止码；workflow 支持 validation、循环、HTTP 节点；浏览器可观察。|一次单任务不足以处理采购清单。增加顺序草稿准备、每行真实结果、中断后查询恢复；不复制任意网址、自动视觉修复或无人批准写入。|
|[browser-use](https://github.com/browser-use/browser-use/blob/main/AGENTS.md#agent-history)|执行历史提供 actions、errors、结构化结果及耗时查询。|已有逐条证据，但缺少跨记录筛选与交接。增加按部门/错误/处理阶段筛选及报告集合导出；每份保持独立 API 观察时间和失败。|
|[workflow-use](https://github.com/browser-use/workflow-use#how-it-works)|记录一次流程并提取参数化步骤，存储后复用；README 明确尚在早期，不建议生产使用。|借鉴参数化输入，使用固定采购字段模板。现有适配器遇 DOM 漂移仍停止；不用模型猜定位或套用其自动修复。|

许可查证：[Activepieces LICENSE](https://github.com/activepieces/activepieces/blob/main/LICENSE) 对企业目录单列许可，其余范围 MIT Expat；[browser-use](https://github.com/browser-use/browser-use#terms-of-service) Python 库 MIT，云浏览器和模型收费另列；[Skyvern LICENSE](https://github.com/Skyvern-AI/skyvern/blob/main/LICENSE) 与 [workflow-use LICENSE](https://github.com/browser-use/workflow-use/blob/main/LICENSE) 是 AGPL-3.0。以上只借产品机制，本次代码独立实现，无引入第三方源码或模型权重。

选择三项连贯能力：准备清单 → 每行未批准草稿 → 逐条原审批/执行 → 运营队列分流 → 新鲜核对交接包。暂不扩大到通用工作流画布、真实企业账号、邮件发送、文件 OCR 或收费执行平台。这样每项新增功能都有可验证用户动作和失败边界。
