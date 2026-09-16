# 类型码、字段白名单与结构化字段（面向 Agent）

本文件回答写库前必须先回答的问题：**这个实体能写哪些属性键？**
答案不是"字段名看着对就行"，而是由实体声明的 `types` 推导。下表是种子定义（`base_version=7`）
的实测快照；目标实例的已发布 definitions 可能已被管理员扩展或调整，动手前一律以
`GET /api/catalog/definitions` 的实际返回为准（读取形状见 [API 行为参考](reference-api-behavior.md)）。

## 唯一硬规则：`attributes` 白名单 = 声明的 `types` 的字段并集

    {
      "entity": {
        "kind": "release",
        "types": ["release"],                       // ← 类型码决定能写哪些属性
        "attributes": {"catalog_number": "VWBS-1531"}
      }
    }

- **不声明 `types`，`attributes` 必须为空**：property 白名单为空集，写任何键（`catalog_number`、`format`、
  `duration`、`role`…）都会 `400 unknown_field: <码>`。技能里的示例载荷都带 `types`，照抄即可。
- 声明了 `types`，但该类型的 `kinds` 不含本实体的 kind → `400 invalid_type: <码>`（如把 `album` 挂到 `release`）。
- 一个实体可以挂**多个同 kind 的类型**（如 work 写 `["animation","film"]`）；可写属性是这些类型
  `fields` 的**并集**，并集之外的键照样被拒。
- `types` 是实体字段，不是属性：类型码本身不要写进 `attributes`。
- 未发布/未声明的自定义码不要写；字段码存在但该类型没挂它，也等于不存在。

**写前自查三步**：① 读 `GET /api/catalog/definitions`；② 取该实体 `types` 对应 `document.types[码].fields` 的并集；
③ 载荷里每个 `attributes` 键都必须在这个并集里（`types` 为空 = 只能写空 `attributes`）。

## 类型码全量清单（种子定义共 20 个）

| kind | 类型码 | 备注 |
| --- | --- | --- |
| `work` | `album`、`song`、`music`、`animation`、`film`、`novel`、`visual_novel`、`indie_game`、`photobook`、`personal` | 10 个。音乐要区分单曲/专辑/纯音乐；`personal` 用于个人创作/自媒体类母体 |
| `agent` | `person`、`group`、`organization`、`character` | 4 个。**四者都没有属性字段**（`fields` 为空），见 [模型缺口](reference-model-gaps.md) |
| `collection`、`content_unit`、`expression`、`release`、`medium`、`track` | 与 kind 同名的单一码 | 必须声明它才能写该 kind 的属性 |

> **没有的码不要自造**：当前没有 `manga`（漫画）、舞台剧/音乐剧、实拍电视剧、纪录片、商业主机游戏等类型码。
> 这类内容只能落到最接近的现有码（漫画当前落 `novel`），语义偏差属于模型缺口，按
> [模型缺口与上报路径](reference-model-gaps.md) 报告，不要发明码或用近似数据填充。

## kind → 类型码 → 可写属性字段

| kind | 类型码 | `attributes` 可写字段 |
| --- | --- | --- |
| `work` | `album` / `song` / `music` | `duration`、`duration_source`、`author`、`language`、`edition_date`、`copyright`、`imdb`、`tags`、`infobox`、`events` |
| `work` | `animation` | `episodes`、`platform`、`broadcast_start`、`broadcast_weekday`、`broadcast_end`、`air_network`、`language`、`edition_date`、`copyright`、`imdb`、`tags`、`infobox`、`events` |
| `work` | `film` | `duration`、`platform`、`language`、`edition_date`、`copyright`、`imdb`、`tags`、`infobox`、`events` |
| `work` | `indie_game` | `platform`、`episodes`、`language`、`edition_date`、`copyright`、`imdb`、`tags`、`infobox`、`events` |
| `work` | `visual_novel` | `platform`、`episodes`、`volume_count`、`language`、`edition_date`、`copyright`、`imdb`、`tags`、`infobox`、`events` |
| `work` | `novel` / `photobook` | `volume_count`、`author`（`novel` 另含 `magazine`）、`language`、`edition_date`、`copyright`、`imdb`、`tags`、`infobox`、`events` |
| `work` | `personal` | `duration`、`language`、`edition_date`、`copyright`、`imdb`、`tags`、`infobox`、`events` |
| `agent` | `person` / `group` / `organization` / `character` | **无**（`attributes` 必须为空对象） |
| `collection` | `collection` | `language` |
| `content_unit` | `content_unit` | `language`、`entry_role`、`air_date`（**没有 `duration`**） |
| `expression` | `expression` | `language`、`duration`、`version_label`、`isrc`、`events` |
| `release` | `release` | `catalog_number`、`barcode`、`isbn`、`edition_date`、`edition_type`、`edition_batch`、`country`、`publisher`、`packaging`、`distribution_channel`、`platform`、`attachments`、`store_bonuses`、`events` |
| `medium` | `medium` | `catalog_number`、`format`、`role` |
| `track` | `track` | `duration`、`role` |

表中只列 `attributes` 的字段码。`title`（**任何 kind 必填**）、`original_language`、`translations`、`types`、
`attributes`、`external_ids`、`pictures`、`status`、`position`、`number` 是所有 kind 共用的实体字段，
不写在 `attributes` 里；`updated_at`、`created_by`、`redirect_id` 只读。
结构性引用字段（`work_id` / `content_unit_id` / `release_id` / `medium_id` / `parent_id` / `contents` / `subjects`）
按 kind 归属，见 [API 载荷模板](reference-api-templates.md)。

两个易错点：

- `duration_source` 是 **entity 字段且只能指向 `expression`**；`publisher` 是 entity 字段且只能指向 `agent`
  （不能指向 release 自己的文本名）。entity 字段要求目标实体**存在、kind 相符、对当前用户可见且未 deleted/merged**。
- `tags` 只出现在 10 个 work 类型上；**release / medium / track / content_unit / expression / collection / agent 都没有
  `tags`**。想表达"初回盘""活动限定""某店特典"这类事实时不要往 Release/Medium/Track 塞 tags，改用
  `edition_type` / `edition_batch` / `attachments` / `store_bonuses`，或按模型缺口上报。

## 词表全量（写入用词项代码，显示名由前端本地化）

| 词表 | 词项 |
| --- | --- |
| `format` | `bd`、`cassette`、`cd`、`digital`、`dvd`、`paper`、`sacd`、`uhd_bd`、`vinyl`、`web` |
| `role` | `primary`、`side`、`extra`、`supplement`、`commentary` |
| `release_role` | `primary`、`compilation`、`supplement` |
| `packaging` | `standard`、`jewel`、`slipcase`、`box`、`boxset`、`digipak` |
| `edition_type` | `standard`、`limited`、`deluxe`、`boxset` |
| `edition_batch` | `first_press`、`regular`、`reissue`、`reprint` |
| `distribution_channel` | `physical`、`digital`、`mixed`、`web` |
| `entry_role` | `main`、`opening`、`ending`、`trailer`、`extra`、`other` |
| `character_rank` | `main`、`supporting`、`guest`、`ensemble`、`narrator`、`cameo` |
| `locator_reference` | `medium`、`track` |

词表外的值一律 `invalid_term`（消息可能带字段前缀，如 `packaging: invalid_term`）。
`country`、`platform`、`version_label`、`credit_role`、`scope`、`magazine` 是**自由文本**，不要当枚举填代码。

## 结构化字段的形状

### `attachments` / `store_bonuses` / `events`（list，元素是同一个记录组）

三个字段形状完全相同，各元素支持的子字段（共 13 个）：

| 子字段 | 类型 | 说明 |
| --- | --- | --- |
| `label` | multilingual | **必填**，形如 `{"zh-CN":"初回特典 BD","ja":"初回特典 Blu-ray"}` |
| `content` | entity | 指向被附带的内容：`work` / `expression` / `content_unit` / `release` / `medium` |
| `store` | entity | 指向店铺/渠道主体（`agent`） |
| `amount` / `currency` | number / text | 金额与币种 |
| `quantity` | number | 数量 |
| `channel` | text | 渠道/平台原文 |
| `condition` | text | 批次、抽选规则或获取条件 |
| `date` | date | 相关日期 |
| `image` / `source_url` | url | 图片与来源链接（绝对 HTTP(S)） |
| `region` | text | 地区 |
| `time_zone` | text | 时区 |

真实例（初回限定同梱 BD + Amazon 店特）：

    "attachments": [
      {"label": {"zh-CN": "初回限定同梱 BD", "ja": "初回限定同梱 Blu-ray"},
       "content": "<medium-uuid>", "quantity": 1},
      {"label": {"zh-CN": "Amazon 特典挂画", "ja": "Amazon 特典タペストリー"},
       "store": "<amazon-agent-uuid>", "channel": "Amazon.co.jp", "condition": "先着"}
    ]

按语义选字段：`attachments` = 包装内同梱物；`store_bonuses` = 按渠道分发的店特；
`events` = 发布/放送事件。三者都能出现在 `release`（`events` 也在 `expression`、所有 work 类型上）。

### `infobox`

`[{"key": "...", "value": "..."}]`，`key` 与 `value` **都必填**（text）。隐藏字段，只放机器/存档用途的信息，
不当作用户可见正文。

### `tags`

**纯字符串数组**（不是对象、不是词项码）：`["动画","剧场版"]`。只有 10 个 work 类型有该字段。
`GET /api/catalog/tags` 是对它的频次聚合，不是可写的字典表。

### `locator`

| 子字段 | 类型 | 语义 |
| --- | --- | --- |
| `relative_to` | enum `locator_reference` | **锚点**：`medium`（整张载体）/ `track`（整条音轨），只有这两个取值 |
| `page_start`、`page_end`、`path`、`chapter` | number / text | `locating`：**本版定位**，随排版/封装变化 |
| `time_start_ms`、`time_end_ms` | number | `content`：**实际内容范围**，参与版本对比 |

- **有任一子字段就必须给 `relative_to`**，否则 `locator: anchor_required: relative_to`；整轨/整篇收录允许 `locator` 为空。
- 显式配对的区间（`page_end` ↔ `page_start`、`time_end_ms` ↔ `time_start_ms`）**只在两端都有值**时校验大小；
  终点单独存在不会被拒。
- 未知子键 → `locator: unknown_field: <键>`。
- 黑胶的 A/B 面位：**没有面位字段**，可用 `track.number` 写 `"A1"`（`number` 是字符串，保留官方原文）；
  线上有一条 `vinyl_track_locator` 场景（scheme）但 `enabled=false`。
- `time_*` 与 `page_*` 语义不同：同一 Expression 在不同版本换页码时，对比口径看 `time_*`。

### `inclusion_attributes` / `subject_attributes`

**当前是空组**：组内没有任何子字段，`contents[].attributes`（收录附加属性）与 `subjects[].attributes`
（发行对象附加属性）写任何键都是 `unknown_field`，检索路径 `inclusion_attributes.x` / `subject_attributes.x`
同样不可用。要表达"本曲原出自哪张专辑""某轨的演奏者"这类事实时：能落到 `expression` / 关系边上的就落过去，
落不下的按 [模型缺口](reference-model-gaps.md) 上报，不要塞进 `locator` 或 `attachments` 凑形状。

## `entry_role` 与 `air_date`

- `content_unit` 可写 `language`、`entry_role`、`air_date`（**没有 `duration`**）。
- `entry_role` 取 `main` / `opening` / `ending` / `trailer` / `extra` / `other`；
  **集数编号在各 `entry_role` 内各自起算**（本篇 1..N，OP/ED 各自从 1 起），不要把 OP 编成"第 13 话"。
- `air_date` 是**篇目级放送/发布日**（逐话首播）；作品级开播日走 work 的 `broadcast_start` / `broadcast_end`。

## `external_ids`

键必须来自 `GET /api/catalog/external-databases` 的预设（当前 35 个码），未注册的键报
`invalid_external_id`。预设带 `category`（`all` / `work` / `release` / `agent`）与校验正则，常见三条：

- `musicbrainz`：36 位 UUID（同一码被 work / release-group / recording 复用，**无语义区分**）；
- `bangumi`：纯数字；
- `isrc`：12 位码（独立码）。

`steam` 预设的 category 是 `work`：写到 release 上会 400 `invalid_external_category`。
`?q=` 检索会返回 draft 实体，但 entity 型字段的引用校验要求目标可见，容易写出"看似存在却写不进去"的载荷。

## 写错时的错误码

| 现象 | 错误码 | 改法 |
| --- | --- | --- |
| 未声明 `types` 却写属性 | `unknown_field: <码>` | 补该 kind 的同名类型码，或删掉该属性 |
| 类型码不属于本 kind / 已禁用 | `invalid_type: <码>` | 用 `document.types` 里 `kinds` 含本 kind 的码 |
| 枚举值不在词表 | `invalid_term`（可能带字段前缀） | 用词项代码，不提交显示名 |
| 组字段写了未声明的子键 | `unknown_field: <键>`（可能带前缀如 `locator: `） | 只写本文列出的子字段 |
| `locator` 有子字段无锚点 | `anchor_required: relative_to` | 补 `relative_to` |
| 外部 ID 键未注册 | `invalid_external_id` | 先读 `/api/catalog/external-databases` |
| 翻译形状/长度不对 | `invalid_translation` / `invalid_locale` / `translation_too_long` | locale 必须是合法语言标签，`title` 非空且 ≤2000，`aliases` 单项 ≤500 |

完整错误码表见 [API 错误码与修复动作](reference-api-errors.md)。
