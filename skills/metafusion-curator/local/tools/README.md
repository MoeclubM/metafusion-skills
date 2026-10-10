# 编目工具

在本目录运行。参数与计划结构查工具 `help/schema`；[凭据](../README.md)，[服务端载荷](../../reference-api-templates.md)。

| 任务 | 工具 |
| --- | --- |
| 外部来源/官方商品页 | `mf-source`；[支持范围与凭据](README-providers.md) |
| 只读目录与当前修订 | `mf-platform` |
| 实体/关系本地编辑与原子推送 | `mf-workspace` |
| 隐藏 Track 收录的单条编辑 | `mf-track-content` |
| 词项 upsert / 受控新增字段 | `mf-definitions`；`--public` 只读，不作写入源 |
| 查重候选/目录快照 | `mf-find-identity`、`mf-catalog-snapshot` |
| 质检 | `mf-audit`、`mf-check-structure`、`mf-audit-external-ids`、`mf-audit-provenance` |
| 合并已核实重复 | `mf-merge`；先 dry-run，多步非原子，部分完成不盲重跑 |

```bash
node mf-source.mjs list
node mf-source.mjs help umj.product
node mf-platform.mjs list
node mf-platform.mjs --plan read-plan.json --out result.json
node mf-workspace.mjs help
node mf-workspace.mjs init --dir ../../workspaces/agent-A
node mf-workspace.mjs checkout --dir ../../workspaces/agent-A --entity <UUID>
node mf-workspace.mjs commit --dir ../../workspaces/agent-A --note "核实题名" --sources sources.json
node mf-workspace.mjs preview --dir ../../workspaces/agent-A
node mf-workspace.mjs push --dir ../../workspaces/agent-A --apply
node mf-definitions.mjs help
```

完整创建、依赖、冲突和恢复流程见[提交与恢复](../../reference-workflow.md)。每个 Agent 独立目录；一个工作区一个待推送提交，未知回执不换 ID。`mf-platform` 只读；旧写计划与 `mf-guarded-update` 不再保留兼容通道。

字段计划仅允许 `action: "field.create"` 新增单个受支持字段；现有同码拒绝，不能用此入口更新字段或替换整份 definitions。`list` 类型须带受支持 Field 形状的 `items`。发行定价示例模板见 [`templates/list-price-field.json`](templates/list-price-field.json)，复制后先用当前管理端 ETag 替换占位符，再预览；发行实体数据形状为 `attributes.list_price=[{amount,currency,tax_included?}]`。

- 来源 `help/list` 不联网；读取用 `run <operation> <arg>`，没有独立 search/fetch 子命令。`--out` 独占新建，不覆盖。
- 平台/定义默认预览；执行需 `--apply --out`，执行开关不提供任务授权。定义工具仅支持词项 upsert 与受控单字段新增；服务端 impact issues 阻断，写后校验完整文档回读。
- 提交不覆盖身份合并、删除、上传、定义管理或任意 HTTP；这些操作使用对应工具和权限。
- Track 的题名、属性、图片和状态可通过提交稀疏编辑，服务端读取完整事实；隐藏收录使用专用 contents 端点。
- 身份候选通过 `POST /api/catalog/entities/candidates` 一次只读快照查找；默认/最大1000，按 Work、Release 或 Medium 作用域限定。截断、错误或 unresolved 不当作无候选，不扫描全 kind。
