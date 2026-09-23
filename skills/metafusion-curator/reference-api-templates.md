# MetaFusion API 载荷参考

这是当前实现的最小载荷参考。提交前先读 `GET /api/openapi.json`、`GET /api/catalog/definitions`
和 [API 行为参考](reference-api-behavior.md)。认证、字段码与可用值以目标实例为准，全站只有 `/api` 这一套前缀。

## 请求头与证据

所有写入接口都是 `/api/catalog/*`，需要登录。凭据三选一（都放在同一个请求头里）：

    Authorization: Bearer <会话令牌 / OAuth 访问令牌 / PAT>
    # PAT 是 `mfp_` 前缀的长期机器凭据：跑脚本或 Agent 时用它，不要共用某个人的会话令牌；
    # 它的有效权限 = 账号现时权限 ∩ 创建时选的 scopes（权限码），不够就 403，无效/吊销/过期是 401 invalid_token
    Content-Type: application/json
    Idempotency-Key: <uuid>        # 可选，仅创建实体 / 创建关系
                                   # 幂等键 = 路由 + 用户 + 键值（不含载荷），24h 内重放返回首次结果；
                                   # 同键换载荷也返回首条 → 键必须唯一标识"这一次创建"，重试复用同一载荷

每次写入都要准备：

    "edit_note": "根据官方发行目录补充初版蓝光的品番与分集目录",
    "sources": [
      {"kind": "url", "citation": "发行方官方目录", "url": "https://example.org/official-catalog"}
    ]

`sources[].kind` 只能是 `url` / `publication` / `self`；`citation` 必填；带 `url` 时必须是可公开访问的 HTTP(S) 地址、
不得含用户信息。缺 `edit_note` 或缺 `sources` 会被拒绝为 `evidence_required`——**这是服务端强制的，不是建议**。
作者自述用 `kind: "self"`，并如实标注。

本机 Agent 使用 `local/metafusion-api.mjs` 与已忽略的 `local/credentials.json`，不要把真实令牌写进任务脚本、命令、报告或提交；所有编目任务共用该客户端。

## 写入信封

创建与更新共用同一信封：`POST /api/catalog/entities`（`expected_version` 必须为 0、`entity.id` 留空）与
`PUT /api/catalog/entities/{id}`（`expected_version` 为回读到的 `version`）。

    {
      "entity": { "...": "见下各 kind" },
      "expected_version": 0,
      "edit_note": "…",
      "sources": [{"kind": "url", "citation": "…", "url": "https://…"}]
    }

PUT 是**整实体替换**：先 GET 完整实体，只改需要改的字段，其余字段原样带回。

## 各 kind 允许的结构字段

| kind | 允许的归属字段（出现在实体上的结构性引用） | 备注 |
| --- | --- | --- |
| `agent` | 无 | 只有 `types`（person / organization / group / character 等） |
| `collection` | 无 | 聚合靠 `includes` 关系 |
| `work` | 无 | 创作署名走关系，不写字段 |
| `content_unit` | `work_id`、`parent_id` | `parent_id` 只能指向同一 Work 的目录项 |
| `expression` | `work_id`、`content_unit_id` | `content_unit_id` 若存在必须同 Work；**没有 `parent_id`** |
| `release` | 无（`subjects` 是唯一结构字段） | 不写 `work_id` |
| `medium` | `release_id`、`parent_id` | `parent_id` 只能指向同一 Release 的 Medium |
| `track` | `medium_id`、`parent_id`、`contents` | `parent_id` 只能指向同一 Medium；`contents` 是唯一收录来源 |

放错 kind 引用字段返回 `invalid_structural_field`；缺归属返回 `parent_required`。

## 每个示例都带 `types`，这不是装饰

`attributes` 的可写字段 = 该实体声明的 `types` 的字段并集：**不声明 `types` 时任何属性键都会被
`400 unknown_field` 拒**，类型码的 `kinds` 不含本 kind 则 `invalid_type`。
下面每个 kind 的示例都带 `types`，照抄即可；类型码清单、逐 kind 字段表与结构化字段形状见
[类型码、字段白名单与结构化字段](reference-types-and-fields.md)。

## 种子默认字段码（动态字段写在 `attributes` 下）

下表是种子定义的默认字段码，**仅作对照**：目标实例的已发布 definitions 可能已被管理员扩展或调整，
提交前一律以 `GET /api/catalog/definitions` 为准，未声明的码不要写。

| kind | 种子字段码 |
| --- | --- |
| work | 公共字段 `language`、`edition_date`、`copyright`、`imdb`、`tags`、`infobox`、`events`，再按 `types` 追加：音乐类 `duration` / `duration_source` / `author`；小说 `volume_count` / `magazine` / `author`；动画 `episodes` / `platform` / `broadcast_start` / `broadcast_weekday` / `broadcast_end` / `air_network`；电影 `duration` / `platform`。work 共有 **10 个类型码**（`album` / `song` / `music` / `animation` / `film` / `novel` / `visual_novel` / `indie_game` / `photobook` / `personal`），逐码字段表见 [类型码、字段白名单与结构化字段](reference-types-and-fields.md) |
| collection | `language` |
| agent | 种子类型（`person` / `organization` / `group` / `character`）**没有任何字段**，`attributes` 必须为空 |
| content_unit | `language`、`entry_role`、`air_date`（**没有 `duration`**） |
| expression | `language`、`duration`、`version_label`、`isrc`、`events` |
| release | `catalog_number`、`barcode`、`isbn`、`edition_date`、`edition_type`、`edition_batch`、`country`、`publisher`、`packaging`、`distribution_channel`、`platform`、`attachments`、`store_bonuses`、`events` |
| medium | `catalog_number`、`format`、`role` |
| track | `duration`、`role` |

注意两点易错项：

- 时长字段码是 **`duration`**（单位秒）；`duration_seconds` 会被严格解析拒收。
- 枚举字段（`format`、`packaging`、`role`、`edition_type`、`edition_batch`、`distribution_channel`、`entry_role`）
  的值是**词项代码**；不存在的码会被拒绝为 `invalid_term`。

## agent

    POST /api/catalog/entities
    {
      "entity": {
        "kind": "agent",
        "title": "新海诚",
        "original_language": "ja",
        "types": ["person"],
        "attributes": {},
        "translations": {
          "ja": {"title": "新海誠"},
          "zh-CN": {"title": "新海诚", "aliases": ["Makoto Shinkai"]},
          "en-US": {"title": "Makoto Shinkai"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "根据官方作品页建立创作者主体",
      "sources": [{"kind": "url", "citation": "官方作品页", "url": "https://example.org/creator"}]
    }

## work

    POST /api/catalog/entities
    {
      "entity": {
        "kind": "work",
        "title": "秒速5厘米",
        "original_language": "ja",
        "types": ["animation", "film"],
        "attributes": {"tags": ["动画", "剧场版"]},
        "external_ids": {},
        "pictures": [
          {
            "url": "https://example.org/covers/5cm.jpg",
            "caption": {"zh-CN": "官方海报", "en-US": "Official poster"},
            "source": {"kind": "url", "citation": "官方站点海报", "url": "https://example.org/official"}
          }
        ],
        "translations": {
          "ja": {"title": "秒速5センチメートル"},
          "zh-CN": {"title": "秒速5厘米", "summary": "作品级简介", "aliases": ["5cm/s"]},
          "en-US": {"title": "5 Centimeters per Second", "summary": "English summary"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "根据官方作品页建立创作母体",
      "sources": [{"kind": "url", "citation": "官方作品页", "url": "https://example.org/official"}]
    }

- `title` 是基础题名，`original_language` 声明它属于哪个语种；原语言题名放在对应 locale 的 `translations` 行里。
- `pictures[].url` 必须是绝对 HTTP(S) 地址：相对路径（如 `/assets/covers/x.webp`）会被拒绝为 `invalid_picture`。
- **不要**提交顶层 `cover_aspect` / `cover_image_url`：它们不在写入 DTO 里，严格解析会直接 `400 invalid_payload`。

## content_unit

    {
      "entity": {
        "kind": "content_unit",
        "types": ["content_unit"],
        "work_id": "<work-uuid>",
        "title": "第 1 话：樱花抄",
        "number": "1",
        "position": 1,
        "attributes": {},
        "translations": {
          "zh-CN": {"title": "第 1 话：樱花抄", "summary": ""},
          "en-US": {"title": "Episode 1: Cherry Blossom"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "根据官方分集目录建立内容单位",
      "sources": [{"kind": "url", "citation": "官方分集目录", "url": "https://example.org/episodes"}]
    }

`position` 是排序，`number` 是印刷/官方编号（字符串，保留 `A1`、`EX` 这类原文，不要改写成整数）。
目录树用同一 Work 内的 `parent_id` 表达：卷、部、篇可以建 group 型 content_unit，再挂子项。

## expression

    {
      "entity": {
        "kind": "expression",
        "types": ["expression"],
        "work_id": "<work-uuid>",
        "content_unit_id": "<content-unit-uuid>",
        "title": "第 1 话 正片母版",
        "position": 1,
        "attributes": {"language": "ja", "duration": 1560},
        "translations": {
          "zh-CN": {"title": "第 1 话 正片母版"},
          "en-US": {"title": "Episode 1 master"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "按官方分集目录建立可复用表达",
      "sources": [{"kind": "url", "citation": "官方分集目录", "url": "https://example.org/episodes"}]
    }

`content_unit_id` 可以省略（表达直接挂在 Work 下）；给定时必须属于同一 Work。
表达是**被 Track 复用的那一层**：同一录音、正文或母版在多个发行里出现时只建一个 expression。

## release

    {
      "entity": {
        "kind": "release",
        "types": ["release"],
        "title": "日本官方初版蓝光",
        "original_language": "ja",
        "subjects": [
          {"work_id": "<main-work-uuid>", "role": "primary", "position": 0},
          {"work_id": "<bonus-work-uuid>", "role": "compilation", "position": 1}
        ],
        "attributes": {
          "catalog_number": "VWBS-1531",
          "barcode": "4988104044952",
          "edition_date": "2008-04-18",
          "edition_type": "boxset",
          "edition_batch": "first_press",
          "country": "JPN",
          "packaging": "boxset",
          "distribution_channel": "physical"
        },
        "translations": {
          "ja": {"title": "日本官方初版 Blu-ray"},
          "zh-CN": {"title": "日本官方初版蓝光", "summary": "单碟发行"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "根据发行方目录核对品番、日期与包装",
      "sources": [{"kind": "url", "citation": "发行方目录", "url": "https://example.org/release"}]
    }

- **`release` 没有 `work_id`**。`subjects` 列出被其载体实际收录表达的**全部** Work；`role` 取 `release_role` 词表
  （`primary` 主作品 / `compilation` 汇编作品 / `supplement` 附加作品）。同一 `(work_id, role)` 只能出现一次。
- **发行版的版名由 `title` 承载**：没有 `edition_name` 字段。品番、条码、日期、版本类别、包装等字段码以
  `GET /api/catalog/definitions` 声明为准，未声明的码会被拒绝。
- 枚举字段填**词项代码**而不是显示名：`packaging` 取 `standard` / `jewel` / `slipcase` / `box` / `boxset` / `digipak`，
  `edition_type` 取 `standard` / `limited` / `deluxe` / `boxset`，`distribution_channel` 取
  `mixed` / `physical` / `digital` / `web`。显示名由前端按词表本地化，不要提交中文或英文显示名。
- `publisher` 是 **entity 型字段**，值是主体实体 ID（字段名就是 `publisher`）；
  与创作者/机构的署名关系仍走关系接口。

## medium

    {
      "entity": {
        "kind": "medium",
        "types": ["medium"],
        "release_id": "<release-uuid>",
        "title": "Disc 1",
        "position": 1,
        "attributes": {"format": "bd", "role": "primary"},
        "translations": {
          "zh-CN": {"title": "第 1 张蓝光"},
          "en-US": {"title": "Disc 1"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "按盒内实物顺序登记主载体",
      "sources": [{"kind": "url", "citation": "包装实物图", "url": "https://example.org/package"}]
    }

`parent_id` 只能指向同一 Release 的 Medium（分卷、子容器）。`format` 取词项代码
（`cd` / `bd` / `uhd_bd` / `dvd` / `vinyl` / `sacd` / `cassette` / `paper` / `digital` / `web`），
`role` 取 `primary` / `supplement` / `side` / `extra` / `commentary`；多碟装各自的品番写在 `medium.attributes.catalog_number`。

## track

    {
      "entity": {
        "kind": "track",
        "types": ["track"],
        "medium_id": "<medium-uuid>",
        "title": "第 1 话：樱花抄",
        "position": 1,
        "attributes": {"duration": 1560, "role": "primary"},
        "contents": [
          {
            "expression_id": "<expression-uuid>",
            "position": 1,
            "locator": {"relative_to": "track", "time_start_ms": 0, "time_end_ms": 1560000}
          }
        ],
        "translations": {
          "zh-CN": {"title": "第 1 话：樱花抄"},
          "en-US": {"title": "Episode 1: Cherry Blossom"}
        },
        "status": "draft"
      },
      "expected_version": 0,
      "edit_note": "按蓝光目录建立第 1 轨并关联表达",
      "sources": [{"kind": "url", "citation": "碟面目录", "url": "https://example.org/disc-1"}]
    }

- **`contents` 是唯一收录来源**，项为 `{expression_id, position, locator, attributes?}`。
  单内容引用走 `contents`（`expression_id` + `position` + `locator`），不要另加引用字段。
- **Track 上没有 `work_id`**：所属 Work 由 `medium → release → subjects` 推导。
  提交 `work_id` 会因为不在该 kind 的允许字段里被拒绝。
- 同一 Track 内 `position` 唯一；同一 `expression_id` **且 locator 完全相同**才算重复收录。
  同一表达按不同时间段切片可以在同一 Track 多次出现（如混音轨引用 0–30s 与 60–90s）。
- `locator` 的子字段码来自 definitions 的 `locator` 组；种子默认含 `relative_to`（锚点，**只有 `medium` / `track`**）、
  `page_start` / `page_end` / `path` / `chapter`（本版定位，随排版变化）与 `time_start_ms` / `time_end_ms`
  （内容范围，参与版本对比）。**有任一子字段时必须给 `relative_to`**；显式配对的起终点
  （`page_end`↔`page_start`、`time_end_ms`↔`time_start_ms`）只在**两端都有值**时校验大小，终点单独存在不报错。
  整轨收录允许 locator 为空。

书籍场景的 locator 示例：

    "locator": {"relative_to": "medium", "page_start": 12, "page_end": 40, "chapter": "第 1 章"}

## 关系

    POST /api/catalog/relations
    {
      "relation": {
        "type": "adaptation_of",
        "source_id": "<work-uuid>",
        "target_id": "<other-work-uuid>",
        "position": 0,
        "attributes": {}
      },
      "expected_version": 0,
      "edit_note": "官方说明该作为原作的改编",
      "sources": [{"kind": "url", "citation": "官方说明", "url": "https://example.org/about"}]
    }

- 关系码与允许的两端 kind / 业务类型来自 `GET /api/catalog/definitions` 的 `document.relations`，
  只使用其中 `enabled` 的条目；关系码清单只从 `document.relations` 取。
  种子关系码的方向、端点与属性字段见 [关系码、方向与属性](reference-relations.md)。
- 种子关系允许 9 个属性字段，实例可通过已发布定义增改：`role`、`credit_role`、`character_rank`、`character`（entity → `agent`）、
  `context`（entity → `work`\|`content_unit`\|`expression`\|`release`）、`language`、`begin_date`、`end_date`、`scope`。
- 服务端拒绝自环（`invalid_endpoints`）与 acyclic 成环（`relation_cycle`；检测只在同一关系码的边集内）；
  **反向边是否判重由目标实例定义的 `symmetric` 决定**；种子 29 条全非 `symmetric`。
- 更新用 `PUT /api/catalog/relations/{id}`；删除用 `DELETE /api/catalog/relations/{id}`，
  **必须带 body**（`expected_version` + `edit_note` + `sources`），不带版本 → 409，完全不带 body → 400。

## 读回检查

不要只凭 2xx 判定成功。至少重新 GET：

- `/api/catalog/entities/{id}`（实体本体与 `version`）；
- `/api/catalog/entities/{id}/relations`（关系与对端实体）；
- `/api/catalog/entities/{id}/occurrences`（表达/内容单位的反向收录）；
- `/api/catalog/entities/{id}/revisions`（本次修订快照与证据；行里只有写后 `snapshot`，**没有 `before`/`after`**）；
- 发行对比用 `/api/catalog/compare?ids=<id1>,<id2>`。

核对返回的 ID、归属（work / release / medium）、`position`、翻译回退、`pictures` 与 revision 内容是否与预期一致。
收到 409 `version_conflict` 时先回读再决定是否重放；响应不明时先查状态，不要盲目重试创建或自动删除已成功的数据。

## 迁移与导入

`POST /api/importer/preview` 与 `POST /api/importer/import`（**前缀是 `/api/importer`，不是 `/api/catalog/importer`**）
 是 Bangumi 预览与按证据导入路径；
需要逐项审查、失败可恢复与可追溯修订时，使用上面的实体与关系端点。
