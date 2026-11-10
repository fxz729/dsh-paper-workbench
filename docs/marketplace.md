# 安装、Release 与自定义插件索引

[返回首页](<../README.md>)

## 版本与发布渠道

- 项目：`fxz729/dsh-paper-workbench`。
- 包名：`@fxz729/dsh-paper-workbench`。
- 首版：`1.0.0`。
- 宿主要求：DSH `0.2.2-rc.1`；Node.js `>=24.9.0`。

安装分发采用 GitHub Release `.tgz` 和 DSH 自定义插件索引。下面给出首版的安装地址与操作步骤；社区公共目录的收录状态另行跟踪。

## Desktop：添加 Release 安装包

1. 备份原文献库及所需配置。
2. 在 Desktop 正在使用的 profile 中停用上游 `@ggboy123/dsh-paper-reader`，避免同时启用两份同名工具／路由。
3. 打开插件管理，添加 HTTPS `.tgz` 地址。
4. 核对包名、版本、来源与安装权限，完成启用。
5. 完全退出并重新打开 DSH，使后端模块与前端页面使用同一版本。

`v1.0.0` 安装包地址如下；发行说明和 SHA-256 校验和见 [Release](https://github.com/fxz729/dsh-paper-workbench/releases/tag/v1.0.0)：

```text
https://github.com/fxz729/dsh-paper-workbench/releases/download/v1.0.0/fxz729-dsh-paper-workbench-1.0.0.tgz
```

可从 Release 下载文件并核对发布者提供的校验信息。普通 Web profile 的命令示例：

```bash
dsh plugin --profile web add https://github.com/fxz729/dsh-paper-workbench/releases/download/v1.0.0/fxz729-dsh-paper-workbench-1.0.0.tgz
```

这里明确操作 `web` profile。Desktop 的 profile 独立，勿把另一个 profile 的安装结果当作 Desktop 已启用。

## 自定义插件索引

在实验插件中启用 **Custom plugin indexes**，打开“插件 → 发现 → 索引源”，添加：

```text
https://raw.githubusercontent.com/fxz729/dsh-paper-workbench/main/marketplace/index.json
```

保存索引源并刷新，在“发现”页面选择“文献工作台”1.0.0 安装、启用，然后完全退出重开 DSH。索引遵循宿主 format 1 合同，已通过当前 DSH 的实际解析器检查；Git 来源固定为完整 40 位 commit，避免分支漂移改变安装内容。

该自定义索引由本仓库维护。新增索引会扩大你信任的插件来源，请核对维护者与固定安装目标。DSH 的自定义索引功能本身不表示项目已获官方收录。

## Git 来源与源码安装

支持 Git 来源的宿主可使用如下 tag 形式作为候选安装输入：

```text
github:fxz729/dsh-paper-workbench#v1.0.0
```

`v1.0.0` 对应的 Git 提交携带 `dist/` 和浏览器预构建资源，Git 来源安装无需开发构建。自定义索引使用固定 commit 目标；日常安装优先使用 Release `.tgz`。

从默认分支进行源码开发时，用锁文件安装开发依赖并重新构建，步骤见[开发指南](<development.md>)。

## 社区目录

本仓库提供 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 的单条目[投稿材料](<../marketplace/SUBMISSION.md>)，按其[贡献指南](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)检查：

- 仓库创建满 1 天。
- 仓库具有 `dsh-plugin` topic。
- 使用其 `data/plugins/OWNER__REPO.yml` 元数据约定。

社区收录需等待仓库年龄门槛及维护者审核；具体申请状态见[社区提交说明](<../marketplace/SUBMISSION.md>)。自定义插件索引和 Release 安装渠道可独立使用。

## 升级与迁移

默认继续使用 `~/.dsh-paper-reader/data`。升级前完整备份，包括隐藏 catalog、元数据、事务记录、旁文件和回收区。先在副本验证旧论文与聊天关联，再恢复自动化开关。一个 profile 中只启用一份文献插件；新旧版本回退前均保留完整快照。

## 发布者核对清单

- [ ] `package.json`、Release tag、资产文件名与索引身份一致。
- [ ] 构建、package 检查与实际 `.tgz` 独立安装 smoke 已记录。
- [ ] tldraw 与其他第三方许可完整，私人 key／凭据／文献未进入包。
- [ ] Release 下载地址可访问，校验信息对应最终资产。
- [ ] 索引使用真实可访问的固定 commit，已用目标宿主解析器读取。
- [ ] 社区投稿状态按实际结果说明。
- [ ] 测试范围、平台跳过与 GUI 待验项写入[发布验证记录](<release/verification.md>)。
