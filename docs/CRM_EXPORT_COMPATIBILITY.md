# CRM 只读兼容与导出约定

本约定用于把 AMZ Guard 的结构化巡检结果准备成可由现有 CRM 审核、导入的交换文件。参考系统仅用于只读了解页面字段；项目不会保存参考账号，不会调用未文档化的写接口，也不会向参考环境提交测试或业务数据。

本文只说明出站导出与推送。CRM 主动读取监测结果及单店免密跳转使用独立凭据，见 [CRM API 文档](CRM_API.md)；启用读 API 不会启用本页的网络推送。

## 当前交付方式

巡检编排调用 CRM 通道时（即使网络推送关闭），会在 `out/channels/crm-export/YYYY-MM-DD/` 生成：

- 带 UTF-8 BOM 的 CSV，便于中文 Excel 和常见 CRM 导入器读取。
- 同名 manifest，记录兼容档案、列顺序、批次和行数。
- 按日 JSONL 审计，供 Dashboard 展示最近生成状态。

目录与文件均使用最小权限（目录 `0700`、文件 `0600`）。所有外部内容在进入 CSV 前进行公式注入防护；导出中不包含证据绝对路径、Webhook、Token、Cookie、OTP、SSO 参数或带 query/fragment 的 URL。

兼容档案固定为 `sellermaking-readonly-v1`，列覆盖店铺健康、Feedback、Review、商品、VOC/退货和通用判定信息：

```text
source_id, entity_type, check, shop_name, shop_key, marketplace_name,
date, sku, fnsku, asin, star, rating, comments, response, order_id,
request_date, return_reason, customer_issue, ncx_rate, cx_health,
disposition, requested_quantity, shipped_quantity, removal_fee, currency,
status, health_score, severity, is_normal, anomaly_reason, checked_at
```

`source_id` 是稳定、不可逆的幂等键。相同店铺、检查项和实体不会因同批重试产生不同身份；实体键还绑定站点及 ASIN/SKU/订单等归属字段。成功账本按完整记录内容摘要去重，其中包括批次与采集时间；后续新批次可再次 upsert 同一实体，不代表只在业务字段变化时才发网络请求。

## 正式推送启用门槛

示例配置默认关闭网络推送，本地兼容 manifest 的模式为 `local-export-only`；这个字段不代表生产通道当前是否启用，网络状态需另查配置和投递审计。在 CRM 负责人提供以下内容前，网络推送保持关闭：

1. 正式且使用 HTTPS 的导入 endpoint。
2. 认证凭据的受保护 EnvironmentFile 配置方式。
3. create/upsert 语义、记录级唯一键和批次级 `Idempotency-Key` 契约。
4. 字段字典、必填项、长度限制、枚举值和错误响应格式。
5. 独立测试租户或明确的 dry-run 能力。

启用时先用脱敏样例在测试租户验证，再由业务负责人批准真实数据。失败重试必须复用同一幂等键；成功账本和尝试审计写入 `out/channels/crm/`，CRM 故障不得阻止主报告与兼容 CSV 落盘。

## 只读边界

- 不使用参考账号做自动登录，不在代码、日志或文档中保存账号密码。
- 不调用新增、编辑、删除、标记处理、重置、同步或导入接口。
- 不猜测私有 API 的业务语义，也不把页面内部接口视作正式集成契约。
- Dashboard 将“CRM 兼容导出”和“CRM 网络推送”分成两个通道，避免把本地文件成功误报为外部系统写入成功。
