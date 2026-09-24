# MetaFusion API 行为参考（面向 Agent）

本文件记录**调用站点接口时能观察到什么**：路径前缀、载荷形状、校验口径、错误码与权限边界。
它是操作参考，不是实现说明；与目标实例的实际响应不一致时一律以响应为准，并在报告里注明差异。

## 版本与读取顺序

- 全站唯一入口是 `/api`，全站只有这一套前缀。`/api/v1/catalog/works`、`/api/v2/catalog/entities` 这类带版本号的路径
  调不通，不要照抄；版本不明时不要尝试写入。
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
创作者与机构走 `agent` kind，系列与世界观走 `collection` kind + 关系——这就是 `Artist` / `Franchise` 两个名字的现行落点。

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
- `duplicate_position` 只管**同一个 `track.contents` 数组内部**的收录序号。同一 `medium` 下两张 `track` 都写
  `position: 1` 服务端**照常接受**（实测 200）；顺序靠自检与约定兜住，不要以为服务端会拦。
- 同一 Track 内同一 Expression **且 locator 完全相同**才判 `duplicate_content`——同一 Expression 按不同时间段
  切片可以在同一 Track 多次出现。
- **跨 Work 收录受 `undeclared_release_subject` 约束**：Track 收录的 Expression 所属 Work 必须在该发行的 `subjects` 中声明。
  多作品盒装因此是**受支持能力**：在发行上声明实际收录表达所属的各 Work；只有来源证明汇编本身是独立创作母体时才另建汇编 Work。
- 引用校验（`reference()`）要求被引用实体存在、kind 相符、对当前用户**可见**且未 `deleted` / `merged`，
  否则 `invalid_reference`。草稿默认不对外可见，所以不能把未发布实体挂到公开条目上。

## 多语言与动态字段

- 所有实体统一使用 `translations` 对象：`{"zh-CN":{"title":"…","summary":"…","aliases":["…"]}}`。
  全站只认这一种对象形状，跨 kind 混用数组形状会被拒收。
- 展示回退：请求语言 → `en-US` → 实体 `original_language` → 基础 `title`。展示值不回写基础题名。
- `attributes.tags` 是平铺**字符串**数组，且**只有 10 个 work 类型有**；标签不是独立字典表，
  `GET /api/catalog/tags` 只是对它的频次聚合。release / medium / track / content_unit / expression 写 tags 会被拒。
- **可写属性由 `types` 决定**：`attributes` 的字段白名单 = 实体声明的 `types` 的字段并集。不声明 `types` 就只能写
  空 `attributes`（否则 `unknown_field`）；类型码的 `kinds` 不含本 kind 则 `invalid_type`。清单与逐 kind 字段表见
  [类型码、字段白名单与结构化字段](reference-types-and-fields.md)。
- 类型、字段、词表、关系、模板、场景（scheme）全部来自 definitions，不在客户端硬编码。
  **返回形状是嵌套的，别读错一层**：

      GET /api/catalog/definitions
      {
        "base_version": <运行时版本>, "state": "published", "created_at": "…", "id": "…",
        "kinds": {"work": {"names": {"zh-CN": "作品", "en-US": "Works", …}}, …},
        "document": {
          "types":        {"album": {"names": {…}, "kinds": ["work"], "fields": ["duration", "duration_source", …]}, …},
          "fields":       {"catalog_number": {"type": "text", "required": false, "enabled": true,
                                             "searchable": true, "comparable": true}, …},
          "vocabularies": {"format": {"names": {…}, "terms": {"cd": {"names": {…}, "enabled": true}, …}}, …},
          "relations":    {"adaptation_of": {"source_kinds": ["work"], "target_kinds": ["work"],
                                             "fields": ["role", "credit_role", …], "acyclic": true,
                                             "symmetric": false, "group": "creative", "enabled": true}, …},
          "templates":    {…}, "schemes": {…},
          "structure":    {"content_unit": {"fields": [{"code": "work_id", "target_kinds": ["work"], "required": true},
                                                       {"code": "parent_id", "scoped_by": "work_id"}]}, …}
        }
      }

  写代码时 `defs.relations` / `defs.types` 取到的是 `undefined`——一律先下到 `document.`；
  kind 的多语言名在**顶层** `kinds`。
- `document.structure` 是**归属必填与父子作用域的唯一机器可读来源**：`expression` / `content_unit` → `work_id`
  （`required: true`），`medium` → `release_id`，`track` → `medium_id`；`parent_id` 由 `scoped_by` 限定同容器；
  `release` 是 `"fields": null, "subjects": true`（**没有 `work_id`**）。固定归属外键及 Release `subjects` / Track `contents`
  必须与数据库约束一致；草稿中的非空 `structure` 若改变这些规则会返回 `fixed_structure_mismatch`。业务关系码可在后台 GUI 扩展。
- `locator` 的键集合不硬编码，来自 definitions 的 `locator` 组。种子默认含 `relative_to`
  （enum `locator_reference`，**只有 `medium` / `track` 两个取值**）、`page_start` / `page_end` / `path` / `chapter`
  （`semantics: locating`，本版定位，随排版变化）与 `time_start_ms` / `time_end_ms`（`semantics: content`，
  实际内容范围，参与版本对比）。**有任一子字段就必须给 `relative_to`**；显式配对的起终点
  （`page_end`↔`page_start`、`time_end_ms`↔`time_start_ms`）只在**两端都有值**时校验大小，终点单独存在不报错。
- Track 的 `locator` / `inclusion_attributes` 方案可配置 `medium_formats`（`format` 词表码）；匹配所属 Medium 的格式，空数组不限。没有匹配方案时回退全局组。改动 Medium 格式会回放现有 Track，冲突返回 `track_scheme_conflict`。
- `role` 词表项的 `is_bonus` 控制发行详情的附赠内容分组；新增用途码可在后台勾选，不依赖词项代码。显式 `false` 与未声明不同；种子升级只补后者，不覆盖 GUI 决策。
- `inclusion_attributes` / `subject_attributes` **当前是空组**：`contents[].attributes` 与 `subjects[].attributes`
  写任何键都是 `unknown_field`。缺落点的事实按 [模型缺口与上报路径](reference-model-gaps.md) 上报，
  不要塞进 `locator` 或 `attachments` 凑形状。
- 旧的顶层 `cover_aspect` / `cover_image_url` 字段**不在写入 DTO 里**：实体封面统一走
  `pictures: [{url, caption:{locale:说明}, taken_at?, source:{kind,citation,url?}}]`；URL 必须是绝对 HTTP(S)。
  DTO 没有 `asset_id`、许可类型、授权范围或期限，`Picture.source` 与实体修订 `sources` 都不是权利记录；
  官方图源不自动授权复用，封面计数须另有权利 sidecar，规则见[字段级来源策略](reference-source-policy.md)。
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
| GET | `/api/catalog/releases/{id}/toc` | 同一快照读取发行、按位置排序的 Medium / Track、去重的可见 Expression 与定义版本 |
| POST | `/api/catalog/expressions/details` | 批量取表达详情（body `{ids:[...]}`，上限 500） |
| GET | `/api/catalog/compare?ids=` | 对比 2–6 个发行 |
| GET | `/api/catalog/shelves`、`/api/catalog/shelves/feed` | 货架规则与求值结果 |
| GET | `/api/catalog/external-databases` | 启用的外部权威库预设 |
| GET | `/api/catalog/tags` | 标签频次聚合（不是可写的字典表） |
| GET | `/api/catalog/me/home-preferences` | 调用者自己的主页偏好 |
| GET | `/api/exchange/entities/{id}` | 导出该实体的快照（只读，匿名可访问） |
| GET | `/api/admin/catalog-definitions` | 定义版本列表（需 `catalog.definitions.manage`；目录服务提供，不属账号） |
| POST | `/api/importer/preview`、`/api/importer/import` | Bangumi 预览 / 按证据导入（**注意前缀是 `/api/importer/*`，不是 `/api/catalog/importer/*`**） |

### 可见性与权限探测

- OpenAPI、definitions、公开 entities、external-databases 可匿名 GET；`home-preferences`、`entities/stats`、developer request-logs、admin definitions / external-databases 等调用者或管理读取需要认证。匿名返回 401；有令牌但 scopes/账号现时权限不足返回 403。
- 草稿与非公开实体按调用者身份过滤；某次目标快照若 draft 总数为 0，只能说明“无样本可比较”，不能据此取消过滤规则。
- 有效 PAT 的一次 200 管理读取只证明该具体权限交集，不证明实体创建、PUT 或关系写权限；禁止用写请求探测的任务必须把写权限标为“未核验”，不能声称全端点统一强制或统一允许。

`field=` 检索只支持**顶层可检索字段**（`document.fields[码].searchable = true`，如 `tags`、`duration`、
`edition_date`、`barcode`）。点号路径在种子定义下**不可用**：`locator.path` → `400 field_not_searchable`，
`inclusion_attributes.translator` / `subject_attributes.seq` / `attributes.tags` → `400 unknown_field`。
只有叶字段声明 `searchable` 且整条链路启用时才可用，不确定就先读 definitions。
实体列表分页是严格边界：`limit` 默认 50、只接受 1–100；`offset` 必须是 ≥0 的整数，`page` 必须是 ≥1 的整数，且 `page` 与 `offset` 互斥。非法值分别返回 `invalid_limit` / `invalid_offset` / `invalid_page`，同时传 `page` 与 `offset` 返回 `pagination_conflict`；不会静默收敛。客户端分页 helper 必须在发请求前做同样校验。

### 限流（每进程按 IP + 完整路由计数）

| 路由 | 上限 | 备注 |
| --- | --- | --- |
| `GET /api/catalog/entities` | 120/min/实例 | 固定窗按客户端 IP + 完整路由计数；同进程会共享，多副本部署下不是全局精确额度 |
| `POST /api/catalog/expressions/details` | 120/min | |
| `GET /api/catalog/tags` | 120/min | |
| `GET /api/catalog/shelves/feed` | 60/min | |
| `GET /api/catalog/compare` | 10/min | |
| `POST /api/importer/preview` | 10/min | |

超限返回 `429 {"error":"rate_limited"}` 并带 `Retry-After` 与 `X-RateLimit-*`。实现是进程内固定窗口；负载均衡后的总吞吐和共享程度取决于副本数，不能把 120/min 宣称为跨实例全局硬上限。
**必须按 `Retry-After` 退避**：并发编目会与同 IP、同实例的其它客户端共享配额；读取可退避重试，写入不要自动或立刻重放。

## 写入接口的实际边界

- **创建**：`POST /api/catalog/entities`，体为 `{entity, expected_version, edit_note, sources}`。
  创建时 `expected_version` 必须为 `0`，且 `entity.id` 必须为空，否则 `id_must_be_empty`。
- **更新**：`PUT /api/catalog/entities/{id}`。**是整实体替换，不是局部 PATCH**：先 GET 完整实体，
  改要改的字段，把无关的可写字段（尤其是 `contents` / `subjects` / `translations` / `attributes`）原样带回，并带当前 `expected_version`。
  响应成功后再次 GET 完整实体逐字段回读，再检查 `relations`、`occurrences` 与当前 `revisions`；不能只凭 200 响应判断完成。
- **生命周期端点只做合并与停用**：`POST /api/catalog/entities/{id}/lifecycle`（管理员，权限
  `catalog.lifecycle.manage`），body 是 `{target_id?, expected_version, edit_note, sources}`，**没有 `action` 字段**。
  `target_id` 留空即停用（`deleted`）、有值即合并（`merged`；目标须同 kind、同归属、已发布，
  否则 `invalid_merge_target`）。带 `{"action":"publish"}` 会 `400 invalid_payload`。
- **发布是 PUT 写 `status: "published"`**（要求至少一条翻译，否则 `translation_required`）。
  `deleted` / `merged` 只能经 lifecycle 端点，普通 PUT 提交这些状态返回 `use_lifecycle_endpoint`。
- **退回走下架端点**：`POST /api/catalog/entities/{id}/unpublish`（管理员，权限 `catalog.lifecycle.manage`），
  body 是 `{expected_version, edit_note, sources}`——**没有 `target_id`**（带上 → `400 invalid_payload`）。
  它是状态机里**唯一**的降级通道，只接受 `published → draft`：下架后回到草稿可继续编辑，修订历史留痕，
  同事务写一条 `entity.unpublished` 事件（不计入贡献统计的 `audit_actions`，那里只数删除与合并）。
  `draft` / `pending_review` 没有可下架的内容、`deleted` / `merged` 是终态，四种情况都 `400 invalid_status`；
  版本不符 `409 version_conflict`，缺证据 `evidence_required`。
  `published` 条目 PUT 回 `draft` 仍被 `use_lifecycle_endpoint` 拒绝；退回须使用下架端点。
- **关系**：`POST /api/catalog/relations`、`PUT /api/catalog/relations/{id}`、`DELETE /api/catalog/relations/{id}`。
  载荷是 `{relation:{type,source_id,target_id,position,attributes}, expected_version, edit_note, sources}`。
  **DELETE 也必须带 body**（`expected_version` + `edit_note` + `sources`）：不带版本 → `409 version_conflict`，
  完全不带 body → `400 invalid_payload`；版本号从 `entities/{id}/relations` 的返回项里取（单条关系的 GET 只有这一个来源）。种子关系码的方向、端点与属性字段见 [关系码、方向与属性](reference-relations.md)。
- **证据载荷是强制的**：所有实体与关系写入都校验 `edit_note` 非空且 `sources` 至少一条，否则 `evidence_required`。
  `sources[].kind` 只能是 `url` / `publication` / `self`，`citation` 必填并应列明支持字段；`kind=url` 或带 `url` 时必须是合法 HTTP(S)
  （无用户信息），否则 `invalid_source`。图片 `pictures[].source` 同样校验。
  Entity 顶层没有 `sources`；它属于 revisions，且是修订级而非字段级 provenance。服务端接受只证明形状，不证明 CORE-P1；
  `self` 不能支撑任何字段值。完整门槛见[字段级来源策略](reference-source-policy.md)。
- **乐观并发**：`expected_version` 与库中版本不符返回 **409 `version_conflict`**。必须回读完整实体、确认并发修改内容，再决定是否基于新版本重做；客户端不得自动重放 `mutate`。
- **创建幂等**：创建实体与创建关系支持 `Idempotency-Key`，记录持久 24h，并按 operation + user + request key 隔离。相同键、相同载荷摘要会重放首次响应；**同键异载荷返回 409 `idempotency_conflict`**，不会静默返回旧结果。键必须唯一标识一次创建，重试复用完全相同载荷。更新、关系 PUT 与删除不靠创建幂等，只用 `expected_version`。
- 线上 OpenAPI 的反射 schema 可能没有列出非空 `required`，也未把 `Idempotency-Key` 声明为 parameter；不能据“OpenAPI 未写”推断请求可省略或不支持，必须结合目标处理器与实际响应。
- **状态与权限**：状态为 `draft` / `pending_review` / `published`（`deleted` / `merged` 只能经 lifecycle 端点，
  `published → draft` 只能经 unpublish 端点）。
  普通角色只能写 `draft` / `pending_review` 且不可触碰已发布条目；`editor` 可维护已发布条目；
  发布、合并、停用与下架归管理员（`catalog.lifecycle.manage`）。发布态要求至少一条翻译，否则 `translation_required`。
- **请求体是严格解析的**：未知字段直接 `400 invalid_payload`，上限 2 MiB。只提交当前 DTO 的字段：写发行版名用
  `title`（`edition_name` 会被拒），时长字段码是 `duration`，单内容引用走 `contents`，封面走 `pictures`；
  `track` 不带 `work_id`，kind 只用八类现行值（`artist` / `franchise` 会判 `invalid_entity`）。

## 读回字段的真实形状

断言"响应里有/没有某字段"之前先看清形状（实测）：

- `revisions` 行只有**写后快照**：`{id, version, actor_id, actor_name, actor_role, created_at, definition_version, edit_note, sources, snapshot}`——
  **没有 `before` / `after`**。当前证据只认 `revision.version == entity.version`；`sources` 是修订级而非字段级 provenance。
  核对改动要拿 `snapshot` 与当前实体比对，不要去找前后差异字段。
- `GET /api/catalog/entities/{id}/relations` 返回 `{items, entities, subject_id}`：`entities` 是对端实体，
  `subject_id` 是被查实体；关系版本号从这里取。
- 实体 DTO 另含只读 `updated_at`；`pictures[]` 元素可带可选 `taken_at`。
- `GET /api/catalog/entities` 返回 `items` + 真实 `total`（COUNT）；分页边界**可能重复返回同一实体**，
  客户端建本地索引必须按 `id` 覆盖。
- `POST /api/catalog/expressions/details`：body `{ids:[…]}`，上限 500（超出 `too_many_ids`），
  返回 `{items, entities}`；`ids` 为空数组 → `400 invalid_payload`。
- `GET /api/catalog/compare?ids=`：只接受 **2–6** 个发行，1 个或 7 个 → `compare_requires_two_to_six`，
  非 UUID → `invalid_id`。

## 不要过度声称

- **不要**声称这些接口提供跨实体全量 ACID 事务、字段级来源、封面许可字段、完整审计或全库 DAG 证明：
  单次写入是**单实体（或单关系）事务**，修订快照按实体记录；来源只属于修订。
- **不要**用近似数据填补模型缺口，也不要为了绕过校验去改数据库、改触发器或伪造 `work_id`。
- 目标实例的已发布 definitions 与本文的种子默认值可能不同（定义由管理员演进）；
  以 `GET /api/catalog/definitions` 为准，并在报告中列出差异。
