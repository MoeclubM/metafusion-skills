# API 错误码与修复动作（面向 Agent）

写库被拒时响应体形如 `{"error":"<code>"}`，个别码带补充信息（如 `unknown_field: <字段码>`、
`anchor_required: relative_to`）。下表按"看到什么 → 说明什么 → 该怎么做"整理，取自真实实例的实测结果。

## 证据与载荷

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `evidence_required` | 缺 `edit_note`，或 `sources` 为空 | 补一段具体修改说明 + 至少一条来源；`sources[].citation` 必填 |
| `invalid_source` | 来源格式不对 | `kind` 只能是 `url`/`publication`/`self`；带 `url` 时必须是合法 HTTP(S)（不含用户信息） |
| `invalid_payload` | 载荷形状不对（含未知顶层字段） | 严格按当前 DTO 写；旧契约字段（`edition_name`、`duration_seconds`、`artist`…）一律不要提交 |
| `unknown_field: <码>` | 该字段码不在这个类型的可写字段集里 | 先读 `GET /api/catalog/definitions` 取该类型的 `fields`；不要按名称猜字段 |
| `invalid_term` | 枚举值不在词表里 | 用 definitions 里该字段 `vocabulary` 的 `terms`；自由文本字段不要当枚举用 |
| `invalid_reference` | 被引用实体不存在／kind 不符／不可见／已合并 | 先读该实体确认可见性；合并过的先 `/resolve` 取当前身份 |
| `translation_required` | 发布态没有任何翻译 | 至少给一个语种的 `translations` 再发布 |

## 结构归属

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `parent_required` | `content_unit`/`expression` 缺 `work_id`、`medium` 缺 `release_id`、`track` 缺 `medium_id` | 补归属；归属是实体身份的一部分，不是可选字段 |
| `immutable_scope` | PUT 想改 `kind`/`work_id`/`release_id`/`medium_id` | 换归属要重建实体并走 lifecycle 合并/停用，不能改字段 |
| `invalid_structural_field` | `contents` 放到了非 track、`subjects` 放到了非 release | 结构字段只属于各自的 kind |
| `undeclared_release_subject` | Track 收录的表达所属 Work 没在该发行的 `subjects` 里声明 | 在该发行上补 `subjects`（`primary`/`compilation`/`supplement`）；多作品盒装是受支持能力 |
| `duplicate_subject`／`duplicate_position`／`duplicate_content` | 同一发行重复声明同一 Work、同一载体重复 position、同一 Track 重复同一表达且 locator 相同 | 去重；同一表达按不同时间段切片是允许的，locator 必须不同 |
| `constraint_violation` | 跨 Work 的父子、跨 Release 的载体父子等 | 父子只能在同一 Work / Release / Medium 内 |
| `anchor_required: relative_to` | `locator` 填了子字段却没给锚点 | 有页码/时间码时必须给 `relative_to`（取值见 `locator_reference` 词表） |

## 关系

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `invalid_relation_type` | 关系码不存在或未启用 | 只用 `definitions.relations` 里 `enabled` 的码 |
| `invalid_endpoints` | 两端 kind 不符合该关系的 `source_kinds`/`target_kinds`（自环也走这里） | 按定义选两端；自环一律不支持 |
| `invalid_endpoint_types` | 两端动态类型不在 `source_types`/`target_types` 白名单内 | 换用允许的类型，或先补该类型的定义 |
| `relation_cycle` | 有环语义的关系（`acyclic`）会成环 | 改成表达真实层级的方向；不要为绕过而拆两条反向边 |
| `duplicate_relation` | 同类型、同端点、同属性且 `position` 相同的边已存在 | 用不同属性区分（如不同 `credit_role`/`language`）或先删旧边；`attributes` 缺省与 `{}` 视为同一条边 |
| `cardinality_exceeded` | 该关系定义了 `max_outgoing`/`max_incoming` | 先清理旧边再加 |

## 生命周期与并发

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `version_conflict`（409） | `expected_version` 与库里不一致 | 回读实体取最新 `version` 再重放；不要盲重试 |
| `id_must_be_empty` | 创建时带了 `entity.id` | 创建一律留空 id、`expected_version` 传 0 |
| `use_lifecycle_endpoint` | 用 PUT 提交 `deleted`/`merged`，或把已发布条目降级 | 走 `POST /api/catalog/entities/{id}/lifecycle` |
| `merge_relation_conflict` | 合并会产生"自己指向自己"的边 | 先删掉造成自环的那条关系再合并 |
| `invalid_merge_target` | 合并目标与源不在同一容器（如跨 `content_unit`） | 只合并同一层级里的重复建档 |
| `forbidden`（403） | 角色不足：普通角色碰已发布条目、非管理员走 lifecycle | 用 `editor` 维护已发布条目；发布/合并/停用归管理员 |
| `authentication_required`（401） | 没有有效令牌或令牌过期 | 重新登录或用 refresh 换新令牌 |

## 遇到没见过的错误

1. 先读目标实例的 `GET /api/openapi.json` 与 `GET /api/catalog/definitions`（枚举与字段码的唯一来源）。
2. 用最小载荷复现一次（只留必需字段），先排除自身载荷形状问题。
3. 仍无法解释：**停止写入**，在报告里给出"错误码 + 请求摘要 + 目标实体"，按"实现缺口"上报；
   不要用近似数据填充，也不要绕过接口改库。
