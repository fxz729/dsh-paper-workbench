# 变更记录

## 1.0.0

DSH Paper Workbench 首版，包名为 `@fxz729/dsh-paper-workbench`。发布资产的上传与可安装状态见 [Releases](https://github.com/fxz729/dsh-paper-workbench/releases)，验证范围见[发布验证记录](<docs/release/verification.md>)。

### 文献管理

- 增加 `library_manage` 文献管理工具：库树、嵌套库、本地备注、非覆盖导入、论文详情、已有摘要保存、生成计划、受确认的执行、自动摘要／命名和任务状态。
- 使用稳定 `paperId`／`collectionId`、旧名历史归属与真实 session binding，支撑物理改名后的文献关联及路径复用检查。
- 库备注与文献摘要接入详情界面；提供摘要按需生成与版本检查。
- 全局自动摘要／命名默认关闭，仅对启用后符合资格的新文献生效；自动命名通过共享事务实际改名相关文件。
- GUI 目录导入提供预览、递归 PDF 收集、同名与译文产物跳过，保留外部原件。
- 删除／清空提供计划确认、回收区与恢复提示，保持非递归库操作；模型工具未增加删除或任意配置动作。

### 阅读与伴读

- 文献三栏工作台及普通工作区右侧伴读，复用 DSH 原生聊天。
- PDF 阅读、选文提问、页码跳转、转录检索、学习计划与成绩记录。
- 阅读器注释及独立变体墨迹，保存、导航与库事务协调；tldraw 5.6.0 许可校验保留，生产使用需用户自己的有效 key。

### 翻译与任务

- 保留 OpenAI 兼容端点与 BabelDOC 整篇翻译，后台队列及暂停／恢复／显式重试。
- 批量页筛选、专题全选半选、大批量分段提交、稳定 ID 选择与费用确认。
- 独立全局及按库自动翻译；稳定采样、首次观察资格、发送前校验与未知结果待核实，历史文献不回填。
- 可选 MinerU OCR、embedding 与检索重排。

### 工程与来源

- 服务端维护源码置于 `src/`，墨迹维护源码置于 `src/ink/`；构建生成 `dist/` 与浏览器 bundle。
- 增加公开开发、安装、贡献、安全和第三方许可说明，以及隔离演示资料。
- 基于 [GGboya/dsh-paper-reader 1.6.1](https://github.com/GGboya/dsh-paper-reader) 扩展，保留上游 MIT 归属。原版权与第三方许可见 [LICENSE](<LICENSE>) 和[第三方声明](<THIRD_PARTY_NOTICES.md>)。
