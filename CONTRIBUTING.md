# 贡献指南

修改前阅读 [AGENTS.md](AGENTS.md)、[系统架构](docs/architecture.md)和[安全基线](docs/operations/security.md)。

## 开发流程

1. 从最新 `main` 创建 `codex/<主题>` 分支，保留现有未提交工作。
2. 根据实际页面证据或可复现问题修改代码。新增解析规则须同时添加回归断言。
3. 执行适用验证，检查提交范围，通过 Pull Request 合入主分支。
4. 上线时按[部署手册](docs/operations/deployment.md)记录提交、备份、测试和文件哈希。

环境准备见[本地开发指南](docs/development/getting-started.md)，各端差异处理见[版本管理](docs/development/release-management.md)。

## 验证要求

```bash
npm ci
npm test
npm run docs:check
npm run pack
git diff --check
```

`npm test` 包含 Node 测试和离线自检，不应访问 Amazon 或发送通知。测试数量以本次输出为准。`doctor`、真实采集和通知测试属于在线操作，不加入离线 CI。

安装 Gitleaks 8.30.1 后，执行 `npm run secrets:test` 和 `npm run secrets:check`。工具不在 PATH 时可用 `GITLEAKS_BIN` 指定绝对路径。扫描覆盖本地全部 Git 引用，未提交修改尚未进入历史扫描范围；CI 在提交后复验。不要通过排除测试目录、整文件或任意 `gitleaks:allow` 注释跳过真实凭据。

`src/extractors/*.js` 必须为纯 ASCII、ES5，不使用反引号或模板插值。新增 DOM API 时先扩展测试 stub。解析器或传输层修改不得降低正常判定的证据要求。

## 提交与 Pull Request

提交说明使用 `类型(范围): 变更摘要`，如 `fix(reviews): correct rating label parsing`。一个提交表达一个可解释的变更。

PR 说明包含实际问题、修改后的行为、验证结果，以及适用的发布或回滚事项。附上必要的脱敏证据，不粘贴凭据、买家信息、真实报告或页面原文。

按文件选择暂存，检查 `git diff --cached`。禁止提交 `out/`、真实配置、EnvironmentFile、私钥、依赖和部署归档；不要强制推送主分支。

## 文档维护

按读者和任务拆分文档，每个主题保留一份主要说明。目录和表达要求见[文档规范](docs/development/documentation.md)。功能变更更新相应手册与 [CHANGELOG.md](CHANGELOG.md)，历史事件记录不能作为当前运行结论。
