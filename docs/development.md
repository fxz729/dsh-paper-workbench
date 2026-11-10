# 开发指南

[返回首页](<../README.md>) · [贡献指南](<../CONTRIBUTING.md>)

## 环境

- Node.js `>=24.9.0`。
- DeepSeek Harness `0.2.2-rc.1`，用于实际宿主集成验证。
- npm 及锁文件指定的开发依赖。
- 浏览器测试需要 Playwright 可启动的浏览器；按测试脚本要求准备后再运行。

仓库构建与测试使用项目依赖，不依赖开发者私人文献库、固定盘符或生产凭据。尚待验收的宿主／浏览器条件应记录在[发布验证记录](<release/verification.md>)，不根据截图推断平台支持。

## 目录职责

| 位置 | 职责 |
| --- | --- |
| `src/*.js` | 服务端维护源码：库索引、事务、工具、Host 路由、任务、翻译、转录与检索 |
| `src/ink/` | tldraw 墨迹层维护源码与编辑器模型 |
| `lib/client.js` | 实际 DSH 客户端插件：文献树、布局、菜单与宿主交互 |
| `reader/` | 实际 PDF 阅读器、文献详情与批量翻译页面，以及构建所需静态资源 |
| `dist/` | 构建生成的服务端模块，源自 `src/*.js` |
| `runtime/` | 翻译等功能使用的运行辅助脚本 |
| `tests/` | 单元、集成及隔离演示测试 |
| `examples/` | 可公开的示例生成入口 |
| `licenses/` | 原许可、通知及实际 bundle 依赖声明 |

服务端改动应落在 `src/`，避免只修改生成的 `dist/`。构建脚本复制服务端模块并用 esbuild 生成墨迹等浏览器资产。客户端与阅读器页面按各自实际源文件维护。

## 安装与构建

```bash
npm ci --ignore-scripts
npm run build
```

使用 `--ignore-scripts` 安装后，显式执行项目构建步骤。此过程准备代码与资源；BabelDOC 的首次运行下载属于翻译运行阶段，和前端构建分开。

## 验证入口

```bash
npm run test:library
npm test
npm run test:browser
npm run check:package
npm run pack:release
```

| 命令 | 用途 |
| --- | --- |
| `build` | 复制维护源码并构建浏览器 bundle／相关资源 |
| `test:library` | 定向文献管理测试 |
| `test` | 项目 Node 测试 |
| `test:browser` | 生产组件与本地业务 runtime 的隔离浏览器演示验证 |
| `check:package` | 检查安装包结构、声明和发布约束 |
| `pack:release` | 生成 Release `.tgz` 安装资产 |
| `smoke:install` | 按当前脚本执行独立安装／真实工具 SDK smoke |

命令存在、实际执行成功、宿主 GUI 验收是三项分别记录的事实。测试数量、跳过项、SDK 替身范围、安装 smoke 与实际 Desktop 结果统一见[发布验证记录](<release/verification.md>)。文档示例不作为已经跑通的声明。

### 可选的旧 UI 契约检查

主要浏览器入口为 `npm run test:browser`。需要单独复查保留的批量页／详情页 UI 合同时，可在准备浏览器后执行：

```bash
# Linux 等环境按 Playwright 提示准备 Chromium 及所需系统依赖
npx playwright install chromium
node --test tests/batch-identity.test.mjs tests/details-ui.test.mjs
```

这些辅助契约与主发布演示分开执行；是否已运行及其结果以当前验证记录为准。

## 设计约束

### 稳定身份与单一事务

论文与文献库由 UUID 标识，旧名称 claims 与真实 session binding 用于兼容和歧义检查。Host、界面、工具、观察器和队列共用本地业务服务；异步任务以 ID 重新解析当前引用。

物理改名、导入与回收操作复用事务日志、CAS 与回执。保留非覆盖导入、取消／授权边界、回滚恢复和旧路径重用的拒绝规则。不要在客户端另造一套文件移动逻辑。

### 费用授权

模型工具的 `confirmCosts` 是普通输入。费用操作与工具改名由 owner pre-execute 确认、最终 guard 与可信执行令牌共同约束；请求参数不授予自身权限。

自动摘要／命名采用全局 future-only 资格；翻译维护独立全局／CID 规则。发现观察、启用 fence、稳定 hash 与发送前再校验共同决定资格，保持关闭即撤销与未知请求不自动重发。

### 阅读器与墨迹

真实阅读器保存通过 Gate／短写或长任务准入与文件事务协调。现代删除提交后只对确认受删的 PID 跳过冗余保存，普通导航继续保存旧页；保留原文／译文变体的独立墨迹与 CAS 语义。

tldraw 许可校验属于生产代码。测试可使用隔离替身检查适配逻辑，许可与真实编辑器能力应另列证据，发布物不携带私人 key。

## 浏览器演示与截图

`test:browser` 使用生产页面组件与真实本地业务 runtime，文献为项目生成的公开示例／虚构记录，DSH 外壳与模型交互使用替身。所有截图应标注该范围：

- 展示库管理、详情、批量页与阅读器界面。
- 不把替身模型文本称作真实聊天结果。
- 不把未输入许可的禁用墨迹界面称作生产墨迹验收。
- 不把本地业务通过外推为真实付费端点或所有桌面平台通过。

## 提交与发布前

1. 为行为变化先写失败测试，再做最小修复。
2. 执行对应范围的测试，报告真实退出码和跳过／待验项。
3. 检查 `LICENSE`、第三方通知和 bundle 依赖许可保持完整。
4. 检查 package 白名单，排除私人 key、凭据、文献、会话与临时产物。
5. 用实际 `.tgz` 做独立安装 smoke，再核对 Release URL 与自定义市场索引。
6. 更新变更记录与发布验证记录；对外状态按实际上传／发布结果填写。
