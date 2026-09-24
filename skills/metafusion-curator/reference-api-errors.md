# API 错误码与修复动作（面向 Agent）

写库被拒时响应体形如 `{"error":"<code>"}`。**很多码带前缀或补充信息**，实测形态有：

    {"error":"unknown_field: duration_seconds"}
    {"error":"invalid_type: not_a_type"}
    {"error":"invalid_structural_field: work_id"}
    {"error":"invalid_payload: work.title"}
    {"error":"locator: invalid_term"}
    {"error":"locator: unknown_field: bogus_key"}
    {"error":"locator: anchor_required: relative_to"}
    {"error":"packaging: invalid_term"}
    {"error":"not_supported: media_type_hint"}
    {"error":"four_locale_names_required: ja"}

按 `error == "码"` 做精确匹配的脚本会漏判，请用**前缀匹配**（`error.startsWith("unknown_field")` 这类）。
下表取自真实实例的实测结果；与本文不符时以实例响应为准。

## 证据与载荷

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `evidence_required` | 缺 `edit_note`，或 `sources` 为空 | 补具体修改说明 + 至少一条来源；这只是载荷门，仍须按[字段级来源策略](reference-source-policy.md)逐字段核验 P1 |
| `invalid_source` | 来源格式不对 | `kind` 只能是 `url`/`publication`/`self`；`citation` 必填并列出支持字段；带 `url` 时必须为合法 HTTP(S) 且不含用户信息。`self` 不能支撑字段事实 |
| `invalid_payload` | 载荷形状不对（含未知顶层字段）；消息可能指明位置（`invalid_payload: work.title`） | 严格按当前 DTO 写：发行版名用 `title`、时长用 `duration`、证据用 `sources` 对象数组；未知键一律删掉再试 |
| `id_must_be_empty` | 创建时带了 `entity.id` | 创建一律留空 id、`expected_version` 传 0 |
| `invalid_entity` | kind 不在八类现行值里（如 `artist` 会走到这里）；`title` 缺失/超长 | kind 只用现行八类；`title` 任何 kind 都必填（trim 非空、≤2000） |
| `invalid_entity_type` | importer 的 `entity_type` 不在支持范围 | 只用实例支持的取值（`work` / `release` 等） |
| `not_supported: <开关>` | 该导入开关/来源不支持（如 `media_type_hint`） | 去掉该开关或换来源 |
| `invalid_picture` | 图片形状不对（相对路径、缺 source…） | `pictures[].url` 必须绝对 HTTP(S)；`source` 满足证据规则 |
| `invalid_picture_time` | 图片的可选时间字段不合法 | 去掉或修正 `taken_at` |
| `invalid_url` / `text_too_long` | URL 不合法 / 文本超长 | 按字段上限裁剪，别用截断后的半截 URL |

## 类型、属性、词表与翻译

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `unknown_field: <码>` | 该字段码不在**本实体声明的 types** 的可写字段集里 | 先读 `definitions.document.types[码].fields` 取并集；不声明 `types` 时任何属性键都会被拒 |
| `invalid_type: <码>` | 实体的 `types` 里有不存在/已禁用、或 `kinds` 不含本 kind 的类型码 | 用 `document.types` 里 `kinds` 含本 kind 且 `enabled` 的码 |
| `invalid_term` | 枚举值不在词表里；消息常带字段前缀（`packaging: invalid_term`、`locator: invalid_term`） | 用该字段 `vocabulary` 的**词项代码**；自由文本字段不要当枚举填 |
| `disabled_field` | 该字段码当前未启用 | 换用已启用字段，或按模型缺口上报 |
| `invalid_translation` / `invalid_locale` / `translation_too_long` | 翻译行形状不对 / locale 不是合法语言标签 / 文本超上限 | `translations` 是对象 `{locale:{title,summary,aliases}}`；`title` 非空且 ≤2000，`summary` 与 `aliases` 单项 ≤500 |
| `translation_required` | 发布态没有任何翻译 | 至少给一个语种（通常含 `original_language` 那行）再发布 |
| `invalid_number` / `invalid_date` / `invalid_position` | 数字/日期/序号不合法；消息可能带字段前缀（`edition_date: invalid_date`） | `position` 必须 ≥0；日期用实例接受的格式 |
| `invalid_external_id` / `invalid_external_category` | 外部 ID 的键未注册，或该码的 category 不含这个 kind | 先读 `GET /api/catalog/external-databases` 的 35 个预设与 category |
| `field_not_searchable` | `field=` 检索用了不可检索的码 | 只用顶层 `searchable` 字段（`tags`、`duration`…）；点号路径当前不可用 |
| `four_locale_names_required: <缺的语种>` | 定义/货架/外部库的 `names` 没有四语齐备 | 补 `zh-CN`、`zh-TW`、`en-US` 与 `ja` 或 `ja-JP` |

## 结构归属

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `parent_required` | `content_unit`/`expression` 缺 `work_id`、`medium` 缺 `release_id`、`track` 缺 `medium_id` | 补归属；归属是实体身份的一部分，不是可选字段 |
| `invalid_structural_field: <码>` | 结构性字段放错 kind：`contents` 不在 track、`subjects` 不在 release、`expression` 带 `parent_id`、`release` 带 `work_id`、`track` 带 `work_id` | 按 kind 只保留允许的结构字段（见 [API 载荷模板](reference-api-templates.md)） |
| `immutable_scope` | PUT 想改 `kind`/`work_id`/`release_id`/`medium_id` | 换归属要重建实体并走 lifecycle 合并/停用，不能改字段 |
| `undeclared_release_subject` | Track 收录的表达所属 Work 没在该发行的 `subjects` 里声明 | 在该发行上补 `subjects`（`primary`/`compilation`/`supplement`）；多作品盒装是受支持能力 |
| `duplicate_subject` | 同一 `(work_id, role)` 声明了两次 | 去重；`position` 不是身份 |
| `duplicate_position` | **同一个 `track.contents` 数组内部**的收录序号重复（或为负） | 改 `contents[].position`。注意：**同一 `medium` 下多张 `track` 的 `position` 重复服务端不拦**（实测 200），那不是这个码 |
| `duplicate_content` | 同一 Track 内同一 Expression **且 locator 完全相同** | 换 locator（不同时间段切片是允许的）或去重 |
| `constraint_violation` | 跨 Work 的父子、跨 Release/Medium 的载体父子；也用于"只靠 `position` 区分的重复关系"撞 DB 唯一索引 | 父子只能在同一 Work / Release / Medium 内；区分多边请用 `attributes` |
| `locator: unknown_field: <键>` | `locator` 里写了未声明的子键 | 只写定义声明的子字段 |
| `locator: anchor_required: relative_to` | `locator` 填了子字段却没给锚点 | 有页码/时间码/路径时必须给 `relative_to`（`locator_reference` 词表：`medium` / `track`） |
| `invalid_reference` | 被引用实体不存在／kind 不符／**不可见**／已 `deleted`/`merged` | 引用目标必须可见（`published`）；先读该实体确认；合并过的先 `/resolve` |

## 关系

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `invalid_relation_type` | 关系码不存在或未启用 | 只用 `definitions.document.relations` 里 `enabled` 的码（种子快照见 [关系码、方向与属性](reference-relations.md)） |
| `invalid_endpoints` | 两端 kind 不符合该关系的 `source_kinds`/`target_kinds`（**自环也走这里**） | 按定义选两端；自环一律不支持 |
| `relation_cycle` | 声明 `acyclic` 的关系会成环 | 改成表达真实层级的方向。检测**只在同一关系码的边集内**进行，跨码长路径环看不见 |
| `duplicate_relation` | 同类型、同端点、**同属性**的边已存在（`attributes` 缺省与 `{}` 视为同一条） | 用不同属性区分（不同 `credit_role` / `character` / `language`）或先删旧边。**只改 `position` 无效**，会变成 `constraint_violation` |
| `merge_relation_conflict` | 合并会产生"自己指向自己"的边 | 先删掉造成自环的那条关系再合并 |

**反向边是否判重由 `symmetric` 决定**：声明 `symmetric=true` 的关系会检查反向重复边；种子 29 条**全部 `symmetric=false`**，
A→B 与 B→A 同类型的两条边都合法——需要双向语义就建两条。

## 生命周期与并发

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `version_conflict`（409） | `expected_version` 与库里不一致 | 回读完整实体，确认并发改动后再决定是否基于新版本重做；客户端不得自动重放 mutate。关系删除不带版本也走这里 |
| `use_lifecycle_endpoint` | 用 PUT 提交 `deleted`/`merged`，或把已发布条目降级（`published → draft`） | 停用/合并走 `POST /api/catalog/entities/{id}/lifecycle`（body `{target_id?, expected_version, edit_note, sources}`，没有 `action`）；退回走 `POST /api/catalog/entities/{id}/unpublish`（权限 `catalog.lifecycle.manage`，body `{expected_version, edit_note, sources}`，不能带 `target_id`） |
| `invalid_status` | lifecycle 作用在 `deleted`/`merged` 条目上，或状态值非法；下架端点收到的实体不是 `published`（`draft`/`pending_review` 没有可下架的内容，`deleted`/`merged` 是终态） | 先 `GET` 读回 `status`：已是 `draft` 就不必下架；终止态不可再走 lifecycle，要恢复只能新建 |
| `invalid_merge_target` | 合并目标与源不同 kind／不同归属／不同父级，或目标未发布 | 只合并同一层级、同一容器里的重复建档，目标必须 `published` |
| `forbidden`（403） | 角色不足：普通角色碰已发布条目、非管理员走 lifecycle、member 建关系或调 importer；**停用（`deleted`/`merged`）实体上的关联边删不掉也走这里** | 用 `catalog.entity.edit` 维护已发布条目；发布/合并/停用归 `catalog.lifecycle.manage`；悬空边清理属实例侧缺口，上报而不是反复重试 |
| `authentication_required`（401） | **写端点**没有有效令牌（会话 / OAuth 令牌缺失或验签失败） | 核对本地凭据或重新登录；读端点返回 200 不代表写权限凭据有效 |
| `invalid_token`（401） | **PAT（`mfp_` 前缀）** 无效 / 已吊销 / 已过期 / 账号被封禁，不细分原因 | 确认凭据失效后再选择其他有效凭据；不要因任务结束自动轮换 |
| `auth_unavailable`（503） | PAT 请求问不到账号服务：内省端点不可达 / 超时 / 该服务没配 `AUTH_URL` | 依赖故障，退避重试即可；**不要**当凭据问题去换令牌（换令牌同样 503） |
| `idempotency_conflict`（409） | 同一创建操作、用户和 `Idempotency-Key` 被用于不同载荷摘要 | 不要把响应当重放成功；新的一次创建必须换新 key，原 key 的网络重试必须复用完全相同载荷 |

## 限流

| 错误码 | 含义 | 修复动作 |
| --- | --- | --- |
| `rate_limited`（429） | 超过每进程 IP + 完整路由的固定窗配额：实体检索 / `expressions/details` / `tags` 120/min、货架 feed 60/min、对比与 `importer/preview` 10/min | 读 `Retry-After` 退避；读取可重试，写入不自动或立刻重放。多副本下该值不是全局精确上限 |
| `invalid_limit` / `invalid_offset` / `invalid_page` / `pagination_conflict`（400） | 实体列表分页违反 `limit=1..100`、非负整数 offset、正整数 page，或同时传 page+offset | 修正客户端参数；服务端不会静默收敛。`page` 与 `offset` 二选一 |

## 种子定义中不可达的错误码（"没遇到"不等于漏测）

- `invalid_endpoint_types`：29 条关系的 `source_types` / `target_types` 全为 `null`，白名单不存在；
- `cardinality_exceeded`：29 条关系的 `max_outgoing` / `max_incoming` 全为 `0`，基数上限不存在。

这两条实现里存在；目标实例若扩展了端点类型或基数限制，就可能触发。检查清单按该实例已发布定义标注适用性，不要把种子快照当运行态。

## 遇到没见过的错误

1. 先读目标实例的 `GET /api/openapi.json` 与 `GET /api/catalog/definitions`（枚举与字段码的唯一来源）；
2. 用最小载荷复现一次（只留必需字段），先排除自身载荷形状问题；
3. 仍无法解释：**停止写入**，在报告里给出"错误码 + 请求摘要 + 目标实体"，按"实现缺口"上报；
   不要用近似数据填充，也不要绕过接口改库。
