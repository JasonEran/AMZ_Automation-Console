# 文档索引

文档描述当前源码行为；生产是否已更新须另行核验。运维时间默认为 `Asia/Shanghai`，Amazon 业务日期保留来源口径。

## 入门与开发

| 文档 | 内容 |
| --- | --- |
| [项目首页](../README.md) | 功能范围、边界和快速开始 |
| [系统架构](architecture.md) | WebDriver 流程、模块与数据目录 |
| [本地开发](development/getting-started.md) | 依赖、配置、凭据和命令 |
| [贡献指南](../CONTRIBUTING.md) | 修改、测试、提交与 PR |
| [版本管理](development/release-management.md) | GitHub、交付清单及生产一致性 |
| [文档规范](development/documentation.md) | 目录、命名、表达及链接检查 |

## 运维与安全

| 文档 | 内容 |
| --- | --- |
| [生产部署](operations/deployment.md) | 安装、备份、发布、验收与回滚 |
| [日常运维](operations/operations.md) | 服务、排程、补跑、日志与恢复 |
| [故障排查](operations/troubleshooting.md) | 按故障类型定位与处置 |
| [安全基线](operations/security.md) | 只读约束、凭据、权限与事件响应 |
| [安全问题报告](../SECURITY.md) | 报告方式与证据要求 |

## 功能与参考

| 文档 | 内容 |
| --- | --- |
| [巡检规则](reference/checks.md) | 九项检查、广告判定与 ASIN 生命周期 |
| [Dashboard](features/dashboard.md) | 工作区、账户与行动分类 |
| [运营导览](features/operator-onboarding.md) | 学习路线与交互边界 |
| [实时进度](features/dashboard-progress.md) | 任务状态、刷新与中断提示 |
| [商品上传](features/product-upload.md) | 预检、授权、提交、结果与排障 |
| [竞品情报](features/intelligence.md) | 已实现范围、采样、接口与限制 |
| [CRM API](integrations/crm-api.md) | 只读接口、分页与免密接入 |
| [OpenAPI](crm-openapi.json) | 机器可读接口约定；保留运行时路径 |
| [CRM 数据交换](integrations/crm-export.md) | 兼容导出与正式推送条件 |

## 变更与历史

- [更新记录](../CHANGELOG.md)：已实现变更与已完成验证。
- [历史索引](archive/README.md)：事件复盘、发布核验与历史规划。
