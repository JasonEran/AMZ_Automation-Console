# GitHub 源码同步

仓库：[JasonEran/AMZ_Automation-Console](https://github.com/JasonEran/AMZ_Automation-Console)，私有仓库，主分支 `main`。2026-09-12 建立首个完整源码基线；功能和修复记录见 [CHANGELOG.md](CHANGELOG.md)。

## 获取与验证

```bash
git clone https://github.com/JasonEran/AMZ_Automation-Console.git
cd AMZ_Automation-Console
npm ci
npm test
npm run pack
```

需要 Node.js 22+ 和有仓库权限的 GitHub 登录。`npm test` 包含单元测试和离线自检，不访问 Amazon，不发送通知。`npm run pack` 生成经过文件类型、链接和高置信凭据模式检查的 `dist/amzguard.zip`；归档留在本地，不提交 Git。真实运行环境另按 [README](../README.md) 和 [DEPLOY](../DEPLOY.md) 配置。

## 提交范围

| 提交到 Git | 保留在私有运行环境 |
|---|---|
| `src/`、`test/`、`scripts/`、`deploy/`、`docs/` | `out/` 中的报告、截图、页面文本、销量、情报名单和状态 |
| `package.json`、`package-lock.json`、根目录文档和 `.gitignore` | `config/config.json`、`config/stores.json`、`config/asins.json` |
| `config/*.example.json`、`deploy/**/*.env.example` 中的空值或占位模板 | EnvironmentFile、Keychain 凭据、私钥、证书包、依赖与 `dist/` |

后续开发使用 `codex/` 前缀的工作分支；提交前检查实际差异、运行适用测试，并更新版本记录。示例配置不能填写真实凭据，新增目录也需检查内容；`.gitignore` 不能替代提交审查。

```bash
git status --short
git diff --check
git diff --stat
```

按文件选择暂存后，再执行 `git diff --cached --check` 和 `git diff --cached --stat` 核对本次提交。不要强制推送主分支或把运行目录作为源代码备份。

## GitHub 与生产版本

GitHub 推送不会自动部署生产。需要上线时按 [DEPLOY.md](../DEPLOY.md) 完成备份、发布与验收，并记录：

- `git rev-parse HEAD` 对应的源码提交。
- 发布开始/结束时间、备份位置与测试结果。
- 服务器 `DEPLOYED_MANIFEST.sha256` 校验结果及需要跟进的运行故障。

只同步文档时可以与生产的文档清单存在差异，应记录同步范围；不能仅因 GitHub 已更新就声称服务器重新部署或全系统健康。
