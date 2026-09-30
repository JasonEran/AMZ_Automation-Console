# AMZ Guard

亚马逊店铺巡检、运营看板与独立竞品情报系统。使用 Node.js、紫鸟官方 WebDriver HTTP 和 Selenium，在 Ubuntu 单主机运行采集、报告、Dashboard 和定时任务。

## 功能范围

| 模块 | 功能 |
| --- | --- |
| 店铺巡检 | 店铺健康、账户绩效、Feedback、Reviews、ASIN、Outlet Deal、VOC、广告状态、Inbox 共九项检查 |
| Dashboard | 汇总每店最新报告，展示业务异常、采集问题、证据、历史及进度 |
| 竞品情报 | 独立商品档案、只读采样、变化记录、经营参数与人工复核 |
| 商品上传 | 文件预检、逐任务授权、独立工作者提交和处理结果查询 |
| 通知与集成 | 钉钉告警、CRM 只读 API、免密面板及受控数据交换 |

详细规则见[巡检参考](docs/reference/checks.md)，已实现变更见[更新记录](CHANGELOG.md)。

## 运行边界

- Amazon 页面必须通过对应店铺的紫鸟浏览器访问，禁止绕过紫鸟登录或采集。
- 九项巡检严格只读；Inbox 仅读取列表，不打开会话。
- 商品上传是唯一受控写入口：使用当前登录会话，对预检文件核对店铺与 SHA-256 并完成精确短语确认；双执行闸默认关闭，结果未知时禁止自动重试。
- 正常结论必须具备规定的 DOM 与页面文本证据；未知、缺失、冲突或解析失败均需提醒。
- 凭据、真实配置、报告、截图和运行数据不得提交到 Git。

完整约束见[安全基线](docs/operations/security.md)与 [AGENTS.md](AGENTS.md)。

## 快速开始

要求 Node.js 22+、npm 和私有仓库访问权限。以下命令仅安装依赖并执行离线验证：

```bash
git clone https://github.com/JasonEran/AMZ_Automation-Console.git
cd AMZ_Automation-Console
npm ci
npm test
```

配置环境、凭据和店铺后再启动 Dashboard 或运行采集，见[本地开发指南](docs/development/getting-started.md)。生产安装、更新与回滚见[部署手册](docs/operations/deployment.md)。

## 文档导航

| 目标 | 入口 |
| --- | --- |
| 查找全部文档 | [文档索引](docs/README.md) |
| 了解系统结构 | [系统架构](docs/architecture.md) |
| 开发与提交 | [贡献指南](CONTRIBUTING.md) |
| 同步 GitHub 与生产版本 | [版本管理](docs/development/release-management.md) |
| 值守与排障 | [运维手册](docs/operations/operations.md) · [故障排查](docs/operations/troubleshooting.md) |
| 使用功能 | [Dashboard](docs/features/dashboard.md) · [商品上传](docs/features/product-upload.md) · [竞品情报](docs/features/intelligence.md) |
| 接入 CRM | [接入说明](docs/integrations/crm-api.md) · [OpenAPI](docs/crm-openapi.json) |
| 报告安全问题 | [安全问题报告](SECURITY.md) |

## 仓库结构

```text
src/          采集、解析、服务、页面与独立工作者
test/         离线回归测试
config/       非敏感示例配置；真实配置不入库
deploy/       Linux 部署、systemd、Nginx 与清单工具
scripts/      测试、打包、凭据配置与维护工具
docs/         架构、开发、运维、功能、接口及历史文档
.github/      持续集成与协作模板
out/          私有运行数据与验证结果；不入库
```

GitHub 提交与生产部署是两个独立步骤。是否版本一致，以发布提交和实际交付文件的 SHA-256 核验结果为准。
