# 采购材料与外贸核对：来源、人核和交接

2026-10-11 人类选择“两条都做，OCR、VTT等都考虑”。沿用原自主处理授权，首期交付本地可验证闭环，使用合成材料；不把此选择扩大为真实ERP、邮件、付款或新收费资源授权。

## 目标与边界

同一资料核对工作台提供采购与外贸两条业务线。采购人核后的单项字段手动进入现有propose草稿；外贸对合成合同、订单、产品资料中的名称、数量单位、币种、单价、总额、日期做一致性核对和问题清单。没有法律定性、自动履约或专业翻译准确率承诺。

资料来源统一为带原文依据的MaterialSource：纯文本、WebVTT字幕、带页/区域的OCR分析JSON。VTT实际解析时间码，不调用ASR；原始媒体转录属于既有转录/解析核心的provider。OCR消费现有中立分析结果，不复制A/PA通用识别核心：原始PDF/图片可以本机重算SHA-256对照上游声明，但这不代表重新识别。fixture明确标注，不当真实OCR验收。无新模型/依赖/权重下载。

## 架构选择

选共享来源类型、独立采购/贸易领域映射、服务端租户化材料案例账本。单独平台会重复会话/审批/执行；把所有字段塞采购Plan则破坏权限和哈希边界，因此两者均不采用。

- 来源层：严格schema、唯一span ID、页/区域或时间码、文本及体积边界、导入内容哈希、可选原件哈希对照；不渲染原文HTML或访问资料外链。
- 分析层：规则提取明确字段标签，采购兼容当前中文语句；未识别值生成缺项，候选冲突需人选择/明确忽略。原值、规范值、人工修正及理由分别保存。
- 采购：部门/名称/数量/unit/REQ仍按现有目录和1–100，reason固定；草稿不自动批准/执行，编号生成需人明确确认。
- 外贸：合同/order必须存在才有对照；产品资料辅助名称。数量/币种/日期不猜，不自动换汇/包装换算；金额采用精确十进制运算核对单价×数量，不用浮点容差隐去差异。日期只认明确YYYY-MM-DD，其他格式澄清。
- 案例账本：独立material_cases表和strict API；复用会话、租户、CSRF、来源校验，保持12KB handler/16KB Node限制。revision CAS拒绝旧人核，修改清旧run关联。
- 关联：采购case只关联同租户且载荷匹配的未生效run。来源输入、复核、caseRevision与runRevision/planHash持久保存；报告每次读取当前run检查stale，不拿文件digest当签名。
- 恢复：同源同浏览器会话使用REQ锁和按会话/编号哈希定位的共享待核对标记；未查清结果不重发。它不替代跨设备提案幂等或原后台登记效果去重。
- 页面：独立materials.html，项目导航互通；来源页/时间码可查，候选可人核，服务端保存/恢复，分别生成采购草稿或贸易问题报告。导入、复核、关联均不访问legacy或approve/execute。

## 冻结接口

共同类型在src/materials/types.ts。

来源函数：importTextSource(text, SourceOptions)、importVttSource(text, SourceOptions)、importOcrSource(rawJSON, SourceOptions, computedOriginalHash?)均异步返回MaterialSource；validateMaterialSource(value)用于服务端重新检查结构、来源引用与容量，不信任客户端自报认证。OCR JSON schema office-document-analysis-v1，provider{name,version,kind:ocr|text-layer|fixture}、original{sha256,pages}、spans{id,page,bbox,text}；confidence不授予执行权。

分析函数：extractCandidates(input:MaterialInput):FieldCandidate[]；reviewMaterials(input):MaterialOutcome；procurementDraft(input, requestId?):ProcurementDraft（无执行副作用）。候选ID稳定，缺项也生成可人工补充的候选。decision(action confirm/dismiss)必须引用现有候选；修改或无依据补充须理由。pending不能变consistent；贸易差异允许导出reviewed-with-issues，不称已验证。

API（均在已有认证之后）：GET/POST /api/material-cases；GET /api/material-cases/:id；POST /:id/review {revision,decisions}；POST /:id/link {revision,runId}；GET /:id/report。POST create为MaterialInput（初始decisions为空）；mode和sources不可通过review偷偷替换，换材料建立新case。材料来源与业务payload分开，不改现有propose/approve请求体。

## 验收

真实VTT计时、顺序、重复/重叠cue、HTML注入、NOTE/STYLE安全处理；OCR页/bbox/hash/ref异常；field缺项/多值、型号数字、包装单位；贸易币种/数量/日期/金额差异与小数精度；人核理由、旧revision、租户/CSRF隔离；12KB上限；生成草稿/报告零approve/execute/legacy；刷新后恢复与run修改后stale；移动无横溢出。

独立源码审查ALLOW后完整本地类型/构建/单元/E2E。真实OCR/ASR与生产发布另记收据；旧生产证据截止10月8日，新增本地能力不能冒称已上线或为佳达客户交付。
