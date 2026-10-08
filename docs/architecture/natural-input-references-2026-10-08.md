# 自由文本如何成为工作流参数

2026-10-08 核对官方项目资料，解决“前台买一台打印机”在固定模板入口被整体拒绝的问题。

| 参考 | 实现方式 | 本项目采用的部分 |
| --- | --- | --- |
| [Dify Parameter Extractor](https://docs.dify.ai/en/cloud/use-dify/nodes/parameter-extractor) | 模型将文本提取为定义了类型、必填状态的参数，另外输出成功状态和错误原因 | 提取结果与缺项原因分别返回，下游只接收完整参数 |
| [n8n Information Extractor](https://docs.n8n.io/integrations/builtin/cluster-nodes/root-nodes/n8n-nodes-langchain.information-extractor) | 按属性描述、JSON示例或JSON Schema提取字段，供其他节点使用 | 用户写自由文本，执行节点收到规范字段；无需用户学接口句式 |
| [n8n Structured Output Parser](https://docs.n8n.io/integrations/builtin/cluster-nodes/sub-nodes/n8n-nodes-langchain.outputparserstructured) | 按JSON Schema定义输出结构和验证 | 格式解析与业务范围验证分开，已有Zod校验继续生效 |
| [LangChain structured output](https://github.com/langchain-ai/docs/blob/main/src/oss/langchain/structured-output.mdx) | 使用提供方结构化输出或工具调用，校验schema，反馈验证错误 | 提案输出不能绕开原始输入对应检查或获得执行权限 |

本项目实现 `extractDemand → 缺项补全/编号生成 → demandText → propose → approve → execute → report`。提取器返回部分字段、具体问题和禁止状态，不要求部门/物品/数量固定排列。中文数字转换、别名归一和目录统一分别负责不同问题；缺失值不凭空猜测。

本轮没有复制上述项目代码，也未安装其框架。当前有限目录可用可解释的规则完成提取，所以保留无模型模式和既有可选模型来源；不能将这项改进宣称为通用语义理解或已启用LLM。规则提取器与后端验证共享，未来模型候选仍须经业务schema、用户补全和批准边界。

目录增加前台/打印机时同步表单和DOM适配，不只让页面接受文字而执行端拒绝。目录约束定义可执行范围，句式不定义接口权限。普通表达可以整理；不确定需求明确补全；付款、删除、链接或权限指令仍拒绝。

后续修订：用户在生产输入“一打a4纸”暴露目录和规格计量限制。[物品、规格与计量单位合同](measured-input-2026-10-08.md) supersedes 上述物品枚举约束；物品名称成为受校验的文本字段，单位随入参贯穿执行与证明。部门仍按工作区目录选择。
