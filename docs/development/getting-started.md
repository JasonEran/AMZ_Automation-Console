# 本地开发与验证

适用对象：开发者和负责本地采集环境的维护者。生产发布见[部署手册](../operations/deployment.md)。

## 环境准备

要求 Node.js 22 或更高。先完整退出普通模式紫鸟，再执行：

```bash
git clone https://github.com/JasonEran/AMZ_Automation-Console.git
cd AMZ_Automation-Console
npm ci
test -e config/config.json || cp config/config.example.json config/config.json
test -e config/stores.json || cp config/stores.example.json config/stores.json
test -e config/asins.json || cp config/asins.example.json config/asins.json
npm test
npm run doctor
```

前三条复制命令只在文件缺失时创建，不覆盖已有配置。`npm test` 已包含 `node src/cli.js store-health --self-test`，无需重复运行；这些回归不会启动紫鸟或访问 Amazon。测试数量会随解析规则增长，以命令最终显示的通过数为准。`doctor` 属于环境检查，可能调用紫鸟 `updateCore` 并写日志，不能归为离线测试。

## 凭据配置

紫鸟与钉钉凭据可通过隐藏输入写入当前用户的登录 Keychain：

```bash
npm run credentials:setup
node scripts/configure-credentials.mjs setup dingtalk regular
node scripts/configure-credentials.mjs setup dingtalk operations
node scripts/configure-credentials.mjs status all
```

如果旧的、已被 Git 忽略的 `config/config.json` 曾含内联凭据，先审计再原子迁移；命令不会显示字段值：

```bash
node scripts/migrate-config-secrets.mjs
node scripts/migrate-config-secrets.mjs --apply
```

非 macOS 主机使用受保护的 EnvironmentFile。程序会拒绝加载含内联凭据的 JSON 配置。

## 店铺校准与真机检查

```bash
npm run stores
node src/cli.js run-check store-health --store US-01 --no-close --log-level debug
node src/cli.js run-check performance --store US-01 --no-close --log-level debug
```

初始 `config/stores.json` 中应使用稳定、无敏感含义的 `key`，并填写紫鸟返回的店铺名称或数字 browserId；管理员可在店铺配置页维护，首次保存后以管理清单为准，见[店铺与页面配置](../operations/operations.md#店铺与页面配置)。首次校准检查 `out/` 下报告、脱敏文本和截图；不得因选择器变化而降低正常判定标准。

常用命令：

```bash
node src/cli.js checks
npm run am
npm run ads:off
npm run pm
npm run ads:on
node src/cli.js run-check reviews --store US-01
node src/cli.js run-check inbox --store US-01
node src/cli.js run-check asin-health --store US-01
```

`run-check` / `run-slot` 退出码：`0` 全部正常，`1` 存在业务异常或需关注项，`2` 为环境、配置或采集执行失败。旧 `store-health` 命令部分店铺采集失败时也可能返回 `1`，须逐店查看报告。定时任务将 `0/1` 都视为进程正常结束，但业务异常仍进入报告和告警；`2` 才是服务执行失败。
