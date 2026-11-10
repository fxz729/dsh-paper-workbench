# DSH Paper Workbench · 文献工作台

把文献库管理、PDF 阅读和 DSH 原生 AI 伴读放进同一个工作区。

**核心入口是文献管理工具 `library_manage`**：让模型创建嵌套文献库、维护库备注、复制导入 PDF、保存已有摘要，再按需规划摘要生成与物理命名。图形界面提供文献树、目录导入、库备注、摘要生成和改名预览入口。

- 仓库：[fxz729/dsh-paper-workbench](https://github.com/fxz729/dsh-paper-workbench)
- 包名：`@fxz729/dsh-paper-workbench`，版本：`1.0.0`
- 运行要求：DeepSeek Harness `0.2.2-rc.1`、Node.js `>=24.9.0`。其他宿主版本需另行验证。

## 能做什么

| 工作流 | 功能 |
| --- | --- |
| **文献管理** | 嵌套文献库、本地库备注、非覆盖 PDF 导入、稳定 `paperId`／`collectionId`、带计划与确认的物理改名 |
| **摘要与命名** | 展示论文摘要、界面按需生成、模型已有摘要直接本地保存；全局自动摘要／命名默认关闭，仅处理启用后符合资格的新文献 |
| **阅读与伴读** | 文献树、PDF、DSH 原生聊天三栏；普通工作区也可在右侧阅读文献；页码跳转、选文提问、转录检索与学习记录 |
| **批注与墨迹** | 阅读器注释及可选手写墨迹；原文、中文版与双语版的墨迹独立保存 |
| **整篇翻译** | OpenAI 兼容 API + BabelDOC；后台队列、暂停／恢复、失败重试、有效译本检查；独立的全局或按库自动翻译 |
| **可选增强** | 本地 PDF 文本层转录、可选 MinerU OCR、embedding 与重排 |

### 文献管理工具

直接对 DSH 中的模型说：

> 建一个“课题／方法”子库，备注写“优先阅读可复现实验”。把指定目录中的 PDF 复制导入，保留外部原件。
>
> 这篇论文我已有摘要，帮我保存为本地摘要，不再调用生成 API。
>
> 先为新论文列出摘要和命名计划，等我确认费用后再执行。

工具动作固定为：

| Action | 用途 |
| --- | --- |
| `list` | 读取库树与文献 |
| `create_collection` | 创建根库或子库，附本地备注 |
| `update_collection` | 修改备注；库名变更先返回改名计划，再按计划确认执行 |
| `import_pdfs` | 复制外部 PDF 到指定库，同名不覆盖，保留源文件 |
| `get_paper` | 读取论文或文献库详情 |
| `update_paper` | 本地保存模型已知摘要与书目信息 |
| `plan_enrichment` | 生成摘要／命名费用计划 |
| `run_enrichment` | 经宿主确认后执行指定计划 |
| `set_automation` | 设置全局自动摘要／命名；开启新功能需费用确认 |
| `job_status` | 查询任务状态 |

工具不提供删除或任意配置修改动作。`confirmCosts: true` 表达费用意愿；实际执行仍核对宿主对本次工具调用的授权。更多示例见[使用指南](<docs/usage.md>)。

以下管理画面使用隔离演示环境：虚构资料、生产组件与真实本地 Host/runtime，周围宿主外壳使用替身，不含真实模型会话。

![文献管理：嵌套文献库与库备注编辑的隔离演示](<docs/images/library-management.png>)

## 界面预览

以下截图同样使用虚构文献与自产 PDF，展示生产阅读器、详情与批量页面；宿主外壳使用替身，未输入许可的墨迹功能正常保持禁用。演示不调用模型服务。

![文献树与 PDF 阅读器的隔离演示](<docs/images/workbench.png>)

| 文献摘要与全局自动开关 | 批量翻译与候选筛选 |
| --- | --- |
| ![文献摘要页面，展示虚构资料与默认关闭的自动功能](<docs/images/paper-details.png>) | ![批量翻译页面，展示虚构资料与翻译候选筛选](<docs/images/batch-translation.png>) |

## 安装

**迁移前先备份整个文献库。** 默认数据目录沿用 `~/.dsh-paper-reader/data`。同一 DSH profile 中，请只启用本插件或上游 `@ggboy123/dsh-paper-reader` 中的一份，避免同名工具与路由冲突。

在 DSH Desktop 的“插件 → 添加插件”中输入下面的 Release `.tgz` 安装包地址，安装后启用。发行包、版本说明和 SHA-256 校验和见 [v1.0.0 Release](https://github.com/fxz729/dsh-paper-workbench/releases/tag/v1.0.0)：

```text
https://github.com/fxz729/dsh-paper-workbench/releases/download/v1.0.0/fxz729-dsh-paper-workbench-1.0.0.tgz
```

普通 Web profile 的 CLI 示例：

```bash
dsh plugin --profile web add https://github.com/fxz729/dsh-paper-workbench/releases/download/v1.0.0/fxz729-dsh-paper-workbench-1.0.0.tgz
```

Desktop 安装或替换插件后，请完全退出并重新打开 DSH，使后端模块与前端页面版本一致。

该 CLI 示例操作 `web` profile，Desktop 使用自己的 profile。也可添加本仓库的自定义插件索引后从“发现”页面安装；步骤与社区收录进度见[安装和市场](<docs/marketplace.md>)。

## 开始使用

1. 启用插件，打开“文献库”，创建文献库或子库。
2. 上传 PDF，或选择目录并检查导入预览。目录内 PDF 递归收集到同一目标专题，同名与译文产物跳过，原目录保留。
3. 打开文献：在文献工作台三栏中阅读，也可切回普通工作区使用右侧伴读。
4. 在“文献摘要”中阅读或生成摘要，在“库备注”中编辑本地备注；自动开关初始保持关闭。
5. 需要整篇翻译时再配置兼容端点；聊天模型仍由 DSH provider 管理。

手写墨迹使用 tldraw SDK 5.6.0。**生产使用需要每位用户自行取得并输入有效 tldraw 许可 key**；仓库与安装包不提供私人 key，许可校验保持启用。普通 PDF 阅读与文献管理可单独使用。

## 费用与数据

- 本地库备注、已有摘要保存与普通文献盘点在本地执行。
- 翻译、摘要／命名生成、云端 OCR、embedding 与重排会使用各自配置的服务；配置连接测试也可能产生请求和费用。
- 自动摘要／命名为**全局、默认关闭、future-only**策略，覆盖未来子库；启用时已有文献不回填。自动命名会实际重命名 PDF 及受管理的关联文件。
- 自动翻译与摘要／命名分别控制。全局翻译覆盖当前与未来文献库；按库规则只作用于指定 CID。关闭自动翻译停止新增入队，已入队任务由队列“暂停”控制后续执行。
- 许可 key、端点凭据与私人文献应保留在用户自己的环境中；详见[配置说明](<docs/configuration.md>)和[安全说明](<SECURITY.md>)。

## 文档与验证

- [使用指南](<docs/usage.md>)：文献管理工具、界面、阅读与删除恢复。
- [配置说明](<docs/configuration.md>)：模型、翻译、OCR、许可与数据目录。
- [开发指南](<docs/development.md>)：维护源码、构建与隔离验证。
- [安装和市场](<docs/marketplace.md>)：Release 资产、自定义索引与发布状态。
- [发布验证记录](<docs/release/verification.md>)：由发布维护者记录具体命令、范围与待验项。
- [变更记录](<CHANGELOG.md>) · [贡献指南](<CONTRIBUTING.md>)。

验证记录分别说明本地业务、SDK 注册和实际宿主 GUI 的验收范围；界面演示的范围见上方截图说明。

## 来源与许可

本项目基于 [GGboya/dsh-paper-reader 1.6.1](https://github.com/GGboya/dsh-paper-reader) 扩展，保留 GGboya 的 MIT 版权与许可。应用代码采用 [MIT](<LICENSE>)；tldraw、PDF.js、字体等资源遵循各自原许可，详见[第三方声明](<THIRD_PARTY_NOTICES.md>)。本项目是独立扩展，不以 DSH 官方插件身份发布。
