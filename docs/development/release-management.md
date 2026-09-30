# 源码与发布版本管理

仓库为 [JasonEran/AMZ_Automation-Console](https://github.com/JasonEran/AMZ_Automation-Console)，默认分支为 `main`。GitHub 推送不会自动部署生产；版本一致性必须通过提交标识和文件内容分别核验。

## 版本依据

| 对象 | 核验依据 |
| --- | --- |
| GitHub | 拉取后的 `origin/main` 提交 SHA |
| 本地发布副本 | `HEAD` 与 GitHub 一致，已跟踪文件无未提交改动 |
| 服务器交付文件 | 根据实际文件重新生成 SHA-256 清单，与发布副本逐项比较 |
| 服务器发布记录 | `DEPLOYED_RELEASE.json` 记录提交、Git tree、清单摘要、时间及验证范围 |

文件时间和 `package.json` 的版本号不能证明各端内容一致。只有服务器旧清单自检通过也不足够：旧清单可能遗漏新增文件，必须再生成当前清单比较。

## 提交和交付范围

| 进入 Git 与发布包 | 留在私有运行环境 |
| --- | --- |
| `src/`、`test/`、`scripts/`、`deploy/`、`docs/`、`.github/` | `out/` 中的报告、截图、页面文本、状态和业务数据 |
| 根目录规范文档、`package*.json`、`.gitignore` | `config/config.json`、`stores.json`、`asins.json` |
| `config/*.example.json`、`deploy/**/*.env.example` | EnvironmentFile、Keychain、私钥、依赖及 `dist/` |

发布记录与部署清单保存在服务器，均不提交 Git。临时源码备份也不属于交付内容，应保存在受保护的备份目录。

## 合并各端改动

1. 执行 `git fetch --prune origin`，检查本地分支、主分支和未提交文件。GitHub 多账号环境应使用有权访问该仓库的账号，不在日志输出 Token。
2. 保存服务器当前交付文件清单及必要的源码副本，不下载凭据和运行数据。
3. 按文件比较本地、`origin/main` 与服务器内容。保留线上独有修复与本地未提交工作，不按修改时间直接覆盖。
4. 在工作分支整理变更，运行离线门禁并提交 PR。现有 PR 可能已由其他同步提交包含，须按最终文件内容判断，不能只看 PR 是否仍开放。
5. 合入后重新拉取主分支，从该提交的干净副本发布。

## 发布前门禁

在仓库根目录执行：

```bash
npm ci
npm test
npm run docs:check
npm run pack
git diff --check
git status --short
git rev-parse HEAD
```

`npm test` 为离线测试；`npm run pack` 检查秘密文件类型、链接与高置信凭据模式。真实采集、`doctor` 和通知验证按[部署手册](../operations/deployment.md)另行安排。

## 生产同步与核验

代码或服务配置更新遵循完整部署流程。仅更新文档、测试和仓库工具，且已确认应用源码、依赖和 systemd 单元不变时，可备份后同步限定文件，无需重启 Dashboard 或紫鸟；仍需验证清单、权限和 HTTP 健康状态。

以下命令在本地仓库根目录执行。`AMZGUARD_SSH_TARGET` 应在私有终端中设为实际 SSH 目标，密钥由 SSH 配置管理：

```bash
mkdir -p out/verification
sh deploy/manifest.sh . > out/verification/local.sha256
ssh "$AMZGUARD_SSH_TARGET" \
  'cd /opt/amzguard && sha256sum -c DEPLOYED_MANIFEST.sha256 --quiet'
ssh "$AMZGUARD_SSH_TARGET" \
  'cd /opt/amzguard && sh deploy/manifest.sh .' \
  > out/verification/server.sha256
diff -u out/verification/local.sha256 out/verification/server.sha256
```

只有远程命令成功且 `diff` 无输出，才表示本次交付范围内容一致。不要用流水线掩盖 SSH 或清单生成失败。服务器真实配置和 `out/` 有意不参与代码比较。

完成后持久化 `DEPLOYED_RELEASE.json`，至少记录：完整 Git 提交、Git tree、`DEPLOYED_MANIFEST.sha256` 的摘要、部署时间、备份位置和实际测试结果。两个文件均由 `root:root` 持有，权限为 `0644`，使用临时文件核验后原子替换。

任何“生产健康”结论还必须注明验证范围。离线测试与 HTTP 健康接口不能证明九项巡检的所有业务结果正常。
