# 系统架构

AMZ Guard 使用 Node.js、紫鸟官方 WebDriver HTTP 和 Selenium。生产采用 Ubuntu 单主机部署，Dashboard、定时采集和独立工作者共用私有数据目录。

## 紫鸟官方 WebDriver 流程

项目默认 `ziniao.mode=webdriver`，遵循官方顺序：

```text
完全退出普通紫鸟进程
  → --run_type=web_driver --ipc_type=http --port=18888
  → updateCore（轮询成功）
  → getBrowserList
  → startBrowser（privacyMode=false、cookieTypeLoad=0）
  → Selenium 连接 debuggingPort
  → 打开 launcherPage 恢复平台会话
  → 必要时选择已有 Amazon 账户、Passkey、接受验证码并等待紫鸟填充
  → DOM + 页面文本双路只读采集
  → driver.quit → stopBrowser
```

业务 WebDriver HTTP 超时不低于 120 秒。旧 `ziniao-cli`/ZClaw 只保留为兼容后备，不是生产默认路径。

依据：[紫鸟 WebDriver 指南](https://open.ziniao.com/docSupport?docId=98)、[权限开通](https://open.ziniao.com/docSupport?docId=99)、[自动化 FAQ](https://open.ziniao.com/docSupport?docId=257)、[官方示例仓库](https://github.com/ziniao-open/ziniao_webdriver_demo)。

## 报告、状态与通道

```text
out/
  <check>/latest.json    该检查的最新批次入口
  <check>/YYYY-MM-DD/    JSON、CSV、HTML 与本批证据
    shots/               只读取证截图
    raw/                 已脱敏页面文本
  state/                 AHR、评分、Outlet 等跨次业务基线
  state/intelligence/    独立情报档案、队列、事件、经营参数和复核
  intelligence/          情报采样、事件归档与固定区间的选品销量快照
  alerts/                告警及投递结果审计
  channels/crm/          CRM 尝试、去重和结果审计
  channels/crm-export/   CRM 只读兼容 CSV、manifest 与生成审计
  runtime/               店铺/显示/广告/用户配置、运行锁、实时进度与采集器健康
  logs/                  应用日志
```

报告 URL 在落盘前移除 query 与 fragment，API 不返回服务器绝对路径。历史数据可先 dry-run 再脱敏，脚本会原子替换并保留原修改时间：

```bash
node scripts/sanitize-history.mjs
node scripts/sanitize-history.mjs --apply
```

CRM 使用稳定幂等键、成功账本与相同的重试键；通道失败不会阻止主报告落盘。未取得正式 HTTPS 导入契约前，只生成 [CRM 兼容交换文件](integrations/crm-export.md)，不会向参考 CRM 写入。`npm run test-notify` 会向已启用的通知通道发送明确标注的“测试消息”，而 CRM 只做结构与幂等 dry-run，不会创建虚假业务记录。

CRM 后端也可通过独立认证读取九项店铺监测的「探测结果」与「完整保存数据」，并接入免密巡检面板（默认查看全部已启用店铺，兼容旧单店入口）；此入站接口不触发采集，也不包含竞品情报。接入、字段、分页、权限与 HTTPS 回调条件见 [CRM API 文档](integrations/crm-api.md)。
