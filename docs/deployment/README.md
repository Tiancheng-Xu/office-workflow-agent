# OfficeFlow Cloudflare 部署状态与顺序

## 当前交接：历史生产验收与本轮只读回查

2026-10-04 的最终生产验收已通过，发布提交为 `08cb4f0749981b9fff0b3e2b88ac7950db619c2b`，Pages Git 部署为 `79d9a24b-7aed-42c2-9f10-7e46f6606a55`。原生 Chrome 正式页面完成合成需求提案、确认、云端浏览器登记，D1 为 `applied`，后续独立 API 九项字段检查为 `verified`。这是一条历史生产业务验收，不是本轮新执行。

2026-10-06 本机接续只回读 GitHub main 与三个公开 HTTP 入口：main 仍为上述提交，没有开放 PR；[项目](https://office-workflow-agent.baby2b.online/)、[工作证明](https://office-workflow-agent.baby2b.online/evidence/)和健康接口均返回 200，健康接口的 `X-Office-Release` 匹配发布提交。健康计数为 6 条运行、2 条登记、0 条 unknown。详细边界、响应摘要及原始验收文件校验值见 [只读观察收据](./release-observation-2026-10-06.json)。本轮没有重新启动云端浏览器、写业务数据或部署。

源码里的 `ENABLE_BROWSER_RUN=false` 与 `RELEASE_VERSION=unverified` 是部署失败关闭默认值；它们不能代替运行时的实际参数。10月4日部署时的真实覆盖值见历史收据，10月6日仅回读 release header，没有重新查询运行变量或共享剩余额度。模型关闭、有界规则提案及合成样本是该次验收的边界。十条旅程为本地 HTTP、SQLite、Chromium 的不同终点，含失败；不是十次云端成功。

当前无需重复创建 Worker/Pages/D1、迁移或轮换 secret。新功能或实际故障才形成新的发布待办；未来执行云端浏览器前应核对当时计划与共享额度。10月4日自动 Git 总开关已恢复并回读，但恢复后的 push 自动触发仍需下一次实际变更验证，不能为此创建空提交。

## 2026-10-04 01:36 UTC 历史预检

以下保留早期阻断与部署前顺序。它们不是当前资源状态，也不是要求再次执行的待办；`preflight.json`、`followup.json` 仍是各自日期的历史原始记录。

截至 **2026-10-04 01:36 UTC**，两个自有 D1 的名称/ID 已独立核对，生产与预览配置已分开绑定，Browser Run 和 AI 均关闭。远端读取时两个 runtime Worker 和 Pages 项目仍不存在；迁移、secret 安装与生产运行未验证。后续资源变更由 **root 统一执行**，本收据作者只读核验并更新部署文档。

[preflight.json](./preflight.json) 保留 01:17 UTC 的历史状态，不覆盖为新状态；[followup.json](./followup.json) 保存本轮远端元数据、配置哈希和剩余门槛。后续部署继续保存真实收据，不能把本地配置或数据库存在写成生产已完成。

## 该次预检证据（历史）

| 项目 | 已读到的结果 | 验证边界 |
| --- | --- | --- |
| 生产 D1 | `office-workflow-agent-production` / `19f42ab2-2086-41ef-b99c-ca5781ad6655` | list 元数据匹配，未查询表或验证迁移 |
| 预览 D1 | `office-workflow-agent-preview` / `4ea992c7-482b-4d7d-8cfb-14195ebf7b49` | 独立 ID，未查询表或验证迁移 |
| 生产/预览 Worker | 两个 deployments GET 均返回 Cloudflare code 10007：不存在 | 01:36 UTC 快照，执行前重读 |
| Pages | `office-workflow-agent` 尚不存在；账户 7 个 Pages，其中 5 个 Git 集成 | 其他 Git 项目不证明新仓库 App 权限 |
| 本地 runtime 配置 | 两个 ID 与 live 元数据一致；`workers_dev=false` | 静态配置检查，不等于远端绑定已部署 |
| 本地 Pages 配置 | `env.production` 与 `env.preview` 的 `OFFICE_RUNTIME` 指向不同 Worker | preview 不应写 production D1 |
| 浏览器/AI 门槛 | 两环境 `ENABLE_BROWSER_RUN=false`、`ENABLE_FREE_AI=false`；launch 前要求浏览器开关严格为 `true` | 本轮静态检查，云端效果待部署后验证 |
| preview origin | 仅 HTTPS；项目域下单个 deployment/branch label；拒绝 userinfo、非默认端口 | 生产 runtime 未开启 preview project trust |
| 计划/用量、GitHub App | 均未证实 | 保持对应功能或动作关闭 |

D1 的 `num_tables`、大小及 API `version=production` 仅是列表元数据；不能据此宣称迁移已完成，也不能把预览库的 API version 误当成应用生产环境。两个既有共享数据库以及其他项目资源均不属于本项目写入范围。

## 当时尚需证实的外部门槛（历史）

**Browser Run 免费条件：**只读查看目标账户 **Workers & Pages → Workers plans** 当前计划，以及 **Compute → Browser Run** 共享用量。官方 Workers Free 为每天 600 秒、账户同时 3 个浏览器、新实例间隔 20 秒；超额返回 429 至下个 UTC 日。额度由生产、预览及账户其他项目共享。若计划/用量未知，浏览器保持关闭；若为 Paid，不得仅凭本项目次数上限宣称不会新增费用。[定价](https://developers.cloudflare.com/browser-run/pricing/)、[限制](https://developers.cloudflare.com/browser-run/limits/)

API 替代路径为 `GET /accounts/{account_id}/subscriptions`，需要**既有** Billing Read/Write。原预检读到的 Wrangler OAuth 没有 Billing scope，本轮未扩大权限、读取 token 或重试失效 CUA。AI 保持关闭；启用前另验账户共享 Neuron 用量及模型预算。[订阅读取 API](https://developers.cloudflare.com/api/resources/accounts/subresources/subscriptions/methods/get/)、[AI 定价](https://developers.cloudflare.com/workers-ai/platform/pricing/)

**Git 集成权限：**只读查看 GitHub 已安装的 **Cloudflare Workers and Pages** 现有 repository selection，或 Cloudflare 现有仓库选择器是否出现 `Tiancheng-Xu/office-workflow-agent`。普通 `gh` 用户可读仓库不等于 Cloudflare App 可读；原安装接口的 403/401 属于凭证边界。若目标仓库不在现有范围，记录阻断，不增加仓库、不切 all、不重装 App。[Cloudflare GitHub 集成](https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/)、[GitHub 安装 API](https://docs.github.com/en/rest/apps/installations)

## 当时 root 的最小后续顺序（历史）

1. 运行当前本地验收并记录真实 release commit；配置里的 `unverified` 标记要在部署时替换为实际版本。Git main 基线、开发分支、PR、CI、merge 各自保留证据，不用本收据中的 HEAD 代替最终 commit。
2. 对上表两个自有 D1 分别应用本项目 migrations，核对参数中的 ID/name；共享库不查询、不迁移。保存实际迁移收据，列表元数据不能替代它。
3. 为生产/预览分别安装不同 `SESSION_SECRET`，部署 `office-workflow-agent-runtime` 与 `office-workflow-agent-runtime-preview`，保留 `workers_dev=false`、Browser Run/AI 关闭。secret 用 purpose-built Wrangler 命令安装，文档及日志只保存名称。核对部署后的绑定与版本。
4. 现有 GitHub App 访问通过后，用 **Connect to Git** 或带 `source.type=github` 的官方 Pages POST 创建项目：repo root、`pnpm build`、`dist`、production branch `main`。原 `preflight.json` 的候选 body 可审阅，须结合当前 release 与绑定再核对，未执行。不要用 `wrangler pages project create` 占名；它创建 Direct Upload，不能后改 Git 集成。[创建 API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/create/)、[Direct Upload 限制](https://developers.cloudflare.com/pages/get-started/direct-upload/)
5. Pages 生产/预览分别指向对应 Worker；创建项目可能触发首次构建，所以 Worker/secret/绑定必须先就绪。启用指定 preview 分支前检查隔离库和 actual preview origin；项目下 deployment hash/branch label 的 HTTPS origin 由 preview policy 接受。[环境配置](https://developers.cloudflare.com/pages/functions/wrangler-configuration/)、[service binding](https://developers.cloudflare.com/pages/functions/bindings/)
6. 在实际 Pages 域名读回页面、`/api/session`、提案、人工批准/拒绝、历史与跨会话边界。浏览器关闭时，执行应返回明确的计划未确认错误，不得产生浏览器动作。免费计划及共享用量证据通过后，root 才可在既有授权内开启短时合成浏览器验收；生产/预览数据保持隔离。
7. 自定义域名先读权威 zone，仅新增无冲突记录；发现既有记录则保留并报告。保存 commit → CI/PR/merge → Cloudflare deployment ID → 页面/API/合成任务读回证据，所需门槛通过后才能写“生产已验证”。

本轮仅新增 `followup.json`、更新本 README；保留原 `preflight.json`。未远程查询/迁移/创建，未触碰真实客户数据。禁止购买或升级收费计划、扩大 GitHub App 授权、替换既有 DNS。
