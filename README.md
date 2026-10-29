# 问题簿

给两人协作使用的轻量问题工作台。记录缺陷和需求变更，补充业务流程、根因、前后端方案，跟进修复和回归。

每个问题保存为一个 Markdown 文件；网页、Markdown 导入和 Agent API 共用保存逻辑。每次有效修改自动生成 Git 提交，可以查看变更、恢复旧版本。

## 本地运行

需要 **Node.js 22 或更新版本**和 **Git**，并确认两者在 PATH 中。不需要数据库或 Docker。

```bash
npm install
npm run build
npm start
```

打开 **http://127.0.0.1:3001**。同一局域网的电脑使用启动日志中的“局域网访问”地址，即可共同查看和编辑。关闭运行服务的终端即可停止；重新启动仍然保留数据。

开发模式：

```bash
npm run dev
```

开发页面：http://127.0.0.1:5173，后端默认使用 3001 端口。开发模式和普通运行不要同时占用同一个后端端口。

## 日常使用

- **主题**：右上角的月亮／太阳按钮切换浅色和深色主题。浅色主题采用 [Radix Colors Gray＋Blue](https://www.radix-ui.com/colors)，以中性白灰作为背景、蓝色强调主要操作和选中项；深色主题采用同系列 Gray 的中性黑灰色阶。许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。刷新后保留选择，同一浏览器的其他标签页同步切换；每台电脑可选择自己的主题。
- **提交问题**：标题必填，其他信息可后补。支持图片、PDF、TXT、MP4 和 WebM，单个附件不超过 10 MB。
- **查看与编辑**：点击列表中的问题进入独立详情页，阅读和编辑使用主内容区。问题拥有独立网址，可直接打开或刷新；返回列表保留搜索、筛选和滚动位置。“修改方案”在宽屏下并排展示前后端方案，窄屏下上下排列。未保存时离开页面会提醒确认。
- **可视化**：已有问题的详情页增加独立「可视化」页签，展示业务流程图、预期与实际对照、根因与修改图、验证矩阵。首次进入自动生成；再次进入时按该问题 Markdown 文件的最新 Git 提交检查新旧，过期则自动更新。支持手动重新生成、图表缩放、放大和点击节点查看完整说明。缺失信息留空，验证结论只取自验证原文。生成只使用已保存的文字，不读取截图内容。
- **负责人**：新建、编辑时可勾选前端、后端或双方，默认双方负责，至少选择一项；列表和详情直接展示。旧问题未设置该字段时默认双方负责，不会批量改写原文件。负责人与“是否需要修改”独立。
- **推进状态**：待处理 → 处理中 → 待验证 → 已关闭。验证失败时在编辑中改回“处理中”；已关闭问题可重新打开。
- **Markdown 交换**：详情内一键复制或下载；“导入 Markdown”支持粘贴、选择文件、预览确认。页面也可以复制空白模板。
- **回填原问题**：导出的 Markdown 自带编号和版本，导入时识别已有编号。版本冲突会阻止覆盖；请先合并最新内容。外部不存在的编号会重新分配本地编号。
- **历史**：在“变更记录”中查看每次修改。恢复历史内容会产生一个新版本，保留原有记录。
- **Agent**：侧栏“连接 AI Agent”提供可复制的接入说明。

## 智谱可视化配置

启动时读取项目根目录 `.env`（不覆盖已设置的进程环境变量）。可参考 `.env.example`，将模型设为 `ZHIPU_MODEL=glm-5.3-flash`。

| 配置 | 用途 |
| --- | --- |
| `ZHIPU_API_KEY` | 智谱 Key，仅后端读取，不返回浏览器 |
| `ZHIPU_BASE_URL` | 与 Key 配套的接口地址；独立 Key 默认 `https://open.bigmodel.cn/api/paas/v4` |
| `ZHIPU_MODEL` | 生成模型，默认 `glm-5.3-flash` |

没有显式设置 Key 时，服务端可读取本机 Pi 的 `zai-coding-cn` 凭据和接口配置；目录取 `PI_CODING_AGENT_DIR`，默认 `~/.pi/agent`。只使用该提供商的配置，命令型凭据不会执行。Coding Plan Key 应配套 `https://open.bigmodel.cn/api/coding/paas/v4`，所选模型需有套餐权限。环境变量和 Pi 配置解析后只保存在服务端内存。

首次生成会把当前问题已保存的文字发送给智谱。图表保存在后端独立 JSON 文件，各浏览器共享；同一问题的并发生成共用一次调用。生成途中正文更新时会丢弃旧结果并按最新版本重试一次；超时、生成失败或格式校验失败时保留上一版。未配置模型不影响查看已有图表或使用原有功能。清理图表文件后，再进入页签会重新生成。

## 文件存储与备份

默认数据目录是项目下的 `data/`，启动时自动创建：

| 路径 | 内容 |
| --- | --- |
| `data/issues/ISSUE-0001.md` | 问题正文、YAML 元数据、附件引用 |
| `data/attachments/` | 附件原始文件 |
| `data/visualizations/ISSUE-0001.json` | AI 图表数据、来源 Git 提交、生成时间和模型；独立保存，不写入原始 Markdown、不纳入 Git |
| `data/.git/` | 问题和附件的历史 |

**备份时复制整个 `data/`，包括隐藏的 `.git` 目录。** 本地 Git 历史不等于独立备份。移到其他机器时，也复制整个目录。

Markdown 是正式数据源；列表直接从文件读取，不需要重建数据库。请通过网页或 API 修改，以保证版本和 Git 历史一致。一个数据目录只能启动一个服务实例。

附件在 Markdown 中使用相对路径。复制到外部 Agent 后，它通常无法访问本机附件，需要另行传图。将 Markdown 导入其他工作台时，附件文件也需要迁移。

正文支持普通 Markdown 和代码块。系统导出的文件包含不可见的章节定位注释，用于完整保留正文中的同名小标题；Agent 回填时保留这些注释即可。手写模板中使用二级标题区分字段，正文子章节建议使用 `###`。

## 局域网共同查看与编辑

在一台电脑运行 `npm start`，其他电脑只需打开启动日志中的“局域网访问”链接，例如 `http://192.168.1.5:3001`。两台电脑应连接到同一局域网，运行服务的电脑需要保持开机并让服务持续运行。

网页与 API 使用同一个地址，附件、Markdown 导入、编辑保存和 Git 历史都可以通过局域网使用。所有电脑操作同一份数据，无需在第二台电脑安装项目。列表定时刷新；两人同时修改同一个问题时，后保存的一方会收到版本冲突提示，草稿会保留。

服务默认监听所有 IPv4 网卡，启动日志会自动列出当前局域网地址。可选环境变量：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | 默认允许局域网访问；只允许本机时设为 `127.0.0.1` |
| `PORT` | `3001` | 服务端口 |
| `DATA_DIR` | 项目下 `data` | 独立数据目录 |
| `API_KEY` | 未设置 | 设置后，网页和 API 都需要同一个访问密钥 |

Windows PowerShell 示例：

```powershell
$env:HOST = "0.0.0.0"
$env:API_KEY = "替换为你自己的随机密钥"
npm start
```

macOS / Linux / Git Bash：

```bash
HOST=0.0.0.0 API_KEY=替换为你自己的随机密钥 npm start
```

网页首次连接时输入密钥即可，不需要创建账号。

如果从其他电脑无法访问，检查 Windows 防火墙是否放行服务端口。在运行服务的电脑上，用管理员 PowerShell 执行一次（仅允许专用／域网络的本地子网访问）：

```powershell
New-NetFirewallRule -Name "IssueNote-LAN-3001" -DisplayName "Issue Note - LAN (TCP 3001)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 3001 -Profile Private,Domain -RemoteAddress LocalSubnet
```

当前开发电脑已配置这条规则。端口或部署电脑变化后，需要使用对应端口重新配置。局域网 IP 可能随网络变化，使用启动日志中当前显示的地址。

需要跨公网使用时，请在 HTTPS 反向代理后提供服务。字体可选加载 Google Fonts，网络不可用时自动使用本机中文字体，不影响操作。

## Agent API

所有请求、响应均使用 UTF-8。除文件上传外，请求体使用 JSON。若配置 `API_KEY`，添加 `Authorization: Bearer <密钥>`。默认将 API 修改标记为 Agent 操作；网页自动添加 `X-Client-Source: web`。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 服务与 Git 状态，不需要密钥 |
| GET | `/api/issues` | 列表；支持 `q`、`type`、`status`、`module` 查询参数 |
| GET | `/api/issues/{id}` | 单个问题及当前 `version` |
| POST | `/api/issues` | 创建问题，至少包含 `title` |
| PATCH | `/api/issues/{id}` | 局部更新，必须提供当前 `version` |
| GET | `/api/issues/{id}/markdown` | 完整 Markdown |
| GET | `/api/template` | 空白 Markdown 模板 |
| POST | `/api/issues/import` | `{markdown, preview: true}` 预览；去掉 `preview` 保存 |
| POST | `/api/attachments` | multipart/form-data，字段名 `file` |
| GET | `/api/issues/{id}/visualization` | 图表、来源提交、新旧状态与模型是否配置 |
| POST | `/api/issues/{id}/visualization` | 自动生成或复用，`{force: true}` 强制重新生成 |
| GET | `/api/issues/{id}/history` | Git 变更记录，最多最近 100 次 |
| GET | `/api/issues/{id}/history/{hash}` | 历史内容及与上次保存的差异 |
| POST | `/api/issues/{id}/restore` | `{hash, version}` 恢复历史内容 |

创建示例：

```bash
curl -X POST http://127.0.0.1:3001/api/issues \
  -H "Content-Type: application/json" \
  -d '{"title":"订单金额显示错误","type":"缺陷","module":"订单","description":"使用优惠券后金额未更新。"}'
```

更新示例（先读取当前问题取得 version）：

```json
{
  "version": 1,
  "rootCause": "已确认接口未返回优惠后的金额。",
  "backendRequired": "需要",
  "backendStatus": "处理中",
  "backendPlan": "修正金额计算与返回字段。",
  "status": "处理中"
}
```

### 可更新字段

| 字段 | 值 |
| --- | --- |
| `title` | 非空标题，最长 200 字符 |
| `type` | `缺陷` / `需求变更` / `待确认` |
| `module` | 模块名称，最长 100 字符 |
| `status` | `待处理` / `处理中` / `待验证` / `已关闭` |
| `priority` | `普通` / `紧急` / `较低` |
| `assignees` | `['前端']` / `['后端']` / `['前端', '后端']`，默认双方；至少一项，不可重复，Markdown 同名字段使用 YAML 数组 |
| `description`, `process`, `expected`, `actual` | 描述、业务流程、预期结果、实际结果 |
| `rootCause`, `verification`, `notes` | 根因、验证结果、补充说明 |
| `frontendRequired`, `backendRequired` | `待判断` / `需要` / `不需要` |
| `frontendStatus`, `backendStatus` | `未开始` / `处理中` / `已完成` |
| `frontendPlan`, `backendPlan` | 修改方案 Markdown |
| `attachments` | 上传接口返回的附件对象数组，最多 30 个；更新数组时先保留已有附件 |

`id`、`version`、`createdAt`、`updatedAt` 由系统维护。PATCH 是局部更新；省略字段保持原值，空字符串清空正文。

导入已有问题时，优先检查 Markdown 自带的 `version`；如果文档没有版本，保存请求必须提供预览确认的 `expectedVersion`。响应 `409` 表示版本冲突，应重新读取并合并，不要盲目重试；`428` 表示缺少确认版本。无变化的保存不会增加版本或 Git 提交。

上传附件先返回对象，将该对象加入问题的 `attachments` 后保存问题。恢复问题旧版本不会删除附件。

## 验证

```bash
npm test
npm run build
```

集成测试使用临时目录和真实 Git 仓库，不会修改日常数据。

技术栈：React + TypeScript + Vite、Fastify、Markdown/YAML、Git。
