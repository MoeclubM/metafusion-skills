# 编目工具

在本目录运行。参数与计划结构查工具 `help/schema`；[凭据](../README.md)，[服务端载荷](../../reference-api-templates.md)。

| 任务 | 工具 |
| --- | --- |
| 外部来源/官方商品页 | `mf-source`；[支持范围与凭据](README-providers.md) |
| 目录读取、实体创建/更新、关系创建、单条收录添加 | `mf-platform` |
| 词项 upsert / 受控新增字段 | `mf-definitions`；`--public` 只读，不作写入源 |
| 查重候选/目录快照 | `mf-find-identity`、`mf-catalog-snapshot` |
| 质检 | `mf-audit`、`mf-check-structure`、`mf-audit-external-ids`、`mf-audit-provenance` |
| 合并已核实重复 | `mf-merge`；先 dry-run，多步非原子，部分完成不盲重跑 |

```bash
node mf-source.mjs list
node mf-source.mjs help publisher.bushiroad_music
node mf-source.mjs run publisher.bushiroad_music BRMM-11079
node mf-source.mjs help umj.product

node mf-platform.mjs list
node mf-platform.mjs schema entity.create
node mf-platform.mjs --plan reviewed-plan.json --out preview.json
node mf-platform.mjs --plan authorized-plan.json --apply --out result.json

node mf-definitions.mjs help
node mf-definitions.mjs plan reviewed-term.json --out preview-term.json
node mf-definitions.mjs plan reviewed-field-create.json --out preview-field.json
```

字段计划仅允许 `action: "field.create"` 新增单个受支持字段；现有同码拒绝，不能用此入口更新字段或替换整份 definitions。`list` 类型须带受支持 Field 形状的 `items`。发行定价示例模板见 [`templates/list-price-field.json`](templates/list-price-field.json)，复制后先用当前管理端 ETag 替换占位符，再预览；发行实体数据形状为 `attributes.list_price=[{amount,currency,tax_included?}]`。

- 来源 `help/list` 不联网；读取用 `run <operation> <arg>`，没有独立 search/fetch 子命令。`--out` 独占新建，不覆盖。
- 平台/定义默认预览；执行需 `--apply --out`，执行开关不提供任务授权。定义工具仅支持词项 upsert 与受控单字段新增；服务端 impact issues 阻断，写后校验完整文档回读。
- 平台入口不含删除、生命周期、上传或任意 HTTP；Track 不做整实体 PUT。其余写入与失败判读见 [API 行为](../../reference-api-behavior.md)，证据见 [来源策略](../../reference-source-policy.md)。
