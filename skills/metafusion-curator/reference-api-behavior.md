# MetaFusion API 行为参考（面向 Agent）

本文件记录**调用站点接口时能观察到什么**：路径前缀、载荷形状、校验口径、错误码与权限边界。
它是操作参考，不是实现说明；与目标实例的实际响应不一致时一律以响应为准，并在报告里注明差异。

## 版本与读取顺序

- 全站唯一入口是 `/api`，**没有 `/api/v1`、`/api/v2` 版本前缀**。
  历史文档与第三方适配器里的 `/api/v1/catalog/works`、`/api/v2/catalog/entities` 一类路径**不存在**，不要照抄，
  也不要在版本不明时尝试写入。
- 先读 `GET /api/openapi.json`（实例自描述）与 `GET /api/catalog/definitions`（已发布的动态定义），再读目标实体详情。
  不要从示例里的枚举、默认值或错误码反推服务器行为。
- 与本文不符时以实例响应为准；**不要绕过 API 直接改数据库**，那会让修订与审计失真。

## 固定实体骨架（八类 kind）

| kind | 当前职责与不可破坏的归属 |
| --- | --- |
| `agent` | 责任主体：个人、团体、机构、虚构角色。没有独立 `artist` / `franchise` 实体。 |
| `collection` | 聚合枢纽：系列、企划、世界观。经 `includes` 关系聚合 work。 |
| `work` | 创作母体。`title` 保持纯净题名；`original_language`、简介、标签与创作署名归于此处。 |
| `content_unit` | 同 Work 内的逻辑章/集/篇目目录。必须有 `work_id`；`parent_id` 只能指向同一 Work 的目录项。 |
| `expression` | 可复用的表达（母版、分集正文、录音、译本）。必须有 `work_id`；`content_unit_id` 若存在必须同 Work。 |
| `release` | 一个真实发行版。**没有独占 `work_id`**：被其载体实际收录表达的 Work 全部经 `subjects` 声明。 |
| `medium` | 发行内的盘/卷/文件集。必须有 `release_id`；`parent_id` 只能指向同一 Release 的 Medium。 |
| `track` | Medium 内的位置项。必须有 `medium_id`；`parent_id` 只能指向同一 Medium。收录经 `contents`。 |

`types`（动态业务类型）与 `Kinds` 的关系是：每个类型声明自己允许挂在哪些 kind 上，一个实体可以组合多个类型。
`Artist` / `Franchise` 已分别由 `agent` kind 与 `collection` kind + 关系表达，旧文档里的这两个实体名不再存在。

## 结构不变量

- **保留字段**：`id`、`kind`、`version`、`status`、`created_by`、`work_id`、`parent_id`、`release_id`、
  `medium_id`、`content_unit_id`、`contents`、`subjects`、`redirect_id` 不能塞进 `attributes`。
- **归属必填**：`expression` / `content_unit` 必须 `work_id`；`medium` 必须 `release_id`；`track` 必须 `medium_id`，
  否则 `parent_required`。
- `contents` **只属于 `track`**，`subjects` **只属于 `release`**；放错 kind 返回 `invalid_structural_field`。
- **所属域不可变**：普通 PUT 改 `kind` / `work_id` / `release_id` / `medium_id` 一律返回 `immutable_scope`。
  换归属是**重建实体**并走合并/停用，不是改字段。
- 同一 Subject 的 `(work_id, role)` 唯一，重复返回 `duplicate_subject`；`role` 取 `release_role` 词表
  （`primary` / `compilation` / `supplement`），position 是展示序而不是身份。
- 同一 Track 内 `position` 唯一，重复返回 `duplicate_position`；同一 Expression **且 locator 完全相同**才判
  `duplicate_content`——同一 Expression 按不同时间段切片可以在同一 Track 多次出现。
- **跨 Work 收录受 `undeclared_release_subject` 约束**：Track 收录的 Expression 所属 Work 必须在该发行的 `subjects` 中声明。
  多作品盒装因此是**受支持能力**：给汇编作品建 Work、在发行上声明各 Work，而不是伪造 work_id 或直接改库。
- 引用校验（`reference()`）要求被引用实体存在、kind 相符、对当前用户**可见**且未 `deleted` / `merged`，
  否则 `invalid_reference`。草稿默认不对外可见，所以不能把未发布实体挂到公开条目上。

## 多语言与动态字段

- 所有实体统一使用 `translations` 对象：`{"zh-CN":{"title":"…","summary":"…","aliases":["…"]}}`。
  **没有"某些 kind 用数组、某些 kind 用对象"的分裂**；旧形状（Work/Artist/Franchise 数组）已不存在。
- 展示回退：请求语言 → `en-US` → 实体 `original_language` → 基础 `title`。展示值不回写基础题名。
- `attributes.tags` 是平铺标签数组；标签不是独立字典表，`GET /api/catalog/tags` 是对它的频次聚合。
- 类型、字段、词表、关系、模板、场景（scheme）全部来自 definitions，不在客户端硬编码：
  `GET /api/catalog/definitions` 是枚举与字段码的唯一来源，不要凭记忆引用未定义的码。
  种子默认字段码的对照表见 [API 载荷模板](reference-api-templates.md)。
- `locator` 的键集合不硬编码，来自 definitions 的 `locator` 组。种子默认含
  `relative_to` / `page_start` / `page_end` / `time_start_ms` / `time_end_ms` / `path` / `chapter`；
  `relative_to` 是组的锚点（有页码就必须说明相对谁），`page_end` 相对 `page_start` 校验区间大小，
  `time_*` 被声明为"内容范围"语义，会参与版本对比。收录与发行对象的附加属性走
  `inclusion_attributes` / `subject_attributes` 组。
- 旧的顶层 `cover_aspect` / `cover_image_url` 字段**不在写入 DTO 里**：实体封面统一走
  `pictures: [{url, caption:{locale:说明}, source:{kind,citation,url?}}]`；
  画幅比例若实例定义声明了对应字段码，它在 `attributes` 下，以 `GET /api/catalog/definitions` 为准。

## 读取接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/catalog/definitions` | 已发布的动态定义（类型/字段/词表/关系/模板/场景） |
| GET | `/api/catalog/entities` | 检索：`kind`/`kinds`/`q`/`type`/`types`/`status`/`work_id`/`content_unit_id`/`release_id`/`medium_id`/`parent_id`/`field`/`value`/`tags`，返回 `items` + 真实 `total` |
| GET | `/api/catalog/entities/{id}` | 读取可见实体（存储/互动也用它判定可见性） |
| GET | `/api/catalog/entities/{id}/resolve` | 解析合并后的当前身份 |
| GET | `/api/catalog/entities/{id}/revisions` | 修订历史 |
| GET | `/api/catalog/entities/{id}/relations` | 正向与反向关系，响应同时带回对端 `entities` |
| GET | `/api/catalog/entities/{id}/occurrences` | 反向收录：expression = 自身收录，content_unit = 其表达，work = 其表达 |
| POST | `/api/catalog/expressions/details` | 批量取表达详情（body `{ids:[...]}`，上限 500） |
| GET | `/api/catalog/compare?ids=` | 对比 2–6 个发行 |
| GET | `/api/catalog/shelves`、`/api/catalog/shelves/feed` | 货架规则与求值结果 |
| GET | `/api/catalog/external-databases` | 启用的外部权威库预设 |
| POST | `/api/importer/preview`、`/api/importer/import` | Bangumi 预览 / 按证据导入（**注意前缀是 `/api/importer/*`，不是 `/api/catalog/importer/*`**） |

检索支持点号路径（如 `locator.path`、`inclusion_attributes.translator`、`subject_attributes.seq`），
叶子字段必须 `searchable` 且整条链路启用。限流按 IP：实体检索与 `expressions/details` 120/min，货架 feed 60/min，对比 10/min。

## 写入接口的实际边界

- **创建**：`POST /api/catalog/entities`，体为 `{entity, expected_version, edit_note, sources}`。
  创建时 `expected_version` 必须为 `0`，且 `entity.id` 必须为空，否则 `id_must_be_empty`。
- **更新**：`PUT /api/catalog/entities/{id}`。**是整实体替换，不是局部 PATCH**：先 GET 完整实体，
  改要改的字段，把无关字段（尤其是 `contents` / `subjects` / `translations` / `attributes`）原样带回。
- **生命周期**：`POST /api/catalog/entities/{id}/lifecycle`（发布、退回、合并、停用；管理员）。
  `deleted` / `merged` 只能经该端点，普通 PUT 提交这些状态返回 `use_lifecycle_endpoint`；
  已发布条目降级同样要走该端点。
- **关系**：`POST /api/catalog/relations`、`PUT /api/catalog/relations/{id}`、`DELETE /api/catalog/relations/{id}`。
  载荷是 `{relation:{type,source_id,target_id,position,attributes}, expected_version, edit_note, sources}`。
- **证据是强制的**：所有实体与关系写入都校验 `edit_note` 非空且 `sources` 至少一条，否则 `evidence_required`。
  `sources[].kind` 只能是 `url` / `publication` / `self`，`citation` 必填；`kind=url` 或带 `url` 时必须是合法 HTTP(S)
  （无用户信息），否则 `invalid_source`。图片 `pictures[].source` 同样校验。
  **不存在旧版 `source_urls` 字符串数组**。
- **乐观并发**：`expected_version` 与库中版本不符返回 **409 `version_conflict`**，必须回读后重放，不要盲重试。
- **幂等**：创建实体与创建关系支持 `Idempotency-Key` 头：同一 Key 在 24 小时内重放会返回首次结果，适合网络重试。
  更新与删除靠 `expected_version`，不靠幂等键。
- **状态与权限**：状态为 `draft` / `pending_review` / `published`（`deleted` / `merged` 只能经 lifecycle 端点）。
  普通角色只能写 `draft` / `pending_review` 且不可触碰已发布条目；`editor` 可维护已发布条目；
  发布、合并、停用归管理员。发布态要求至少一条翻译，否则 `translation_required`。
- **请求体是严格解析的**：未知字段直接 `400 invalid_payload`，上限 2 MiB。因此不要提交旧契约里的
  `edition_name`（发行版名由 `title` 承载）、`duration_seconds`（字段码是 `duration`）、
  `canonical_entry_id`、顶层 `cover_aspect` / `cover_image_url`、`track.work_id`，
  以及 `artist` / `franchise` 这类已退役的 kind。

## 不要过度声称

- **不要**声称这些接口提供跨实体全量 ACID 事务、完整审计或全库 DAG 证明：
  单次写入是**单实体（或单关系）事务**，修订快照按实体记录。
- **不要**用近似数据填补模型缺口，也不要为了绕过校验去改数据库、改触发器或伪造 `work_id`。
- 目标实例的已发布 definitions 与本文的种子默认值可能不同（定义由管理员演进）；
  以 `GET /api/catalog/definitions` 为准，并在报告中列出差异。
