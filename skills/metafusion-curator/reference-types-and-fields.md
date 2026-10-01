# 字段适用层级、白名单与结构化字段（面向 Agent）

实体可写属性按当前生效 definitions 的字段适用层级判断。当前实体与定义均无业务分类 `types`；旧 `document.types`、实体 `types` 和基于它们的字段并集不适用。

## 唯一规则：字段自身的 `applicable_kinds` 决定适用层级

先读 `GET /api/catalog/definitions`，取 `document.fields` 中 `applicable_kinds` 包含实体 kind 的字段码。字段值按该字段的 `type`、词表、引用范围、启用状态及子组约束校验；字段的值类型不是实体业务分类。没有适用层级的字段不能直接写到 Entity.attributes，可能专供关系或内嵌组使用。

    {
      "entity": {
        "kind": "release",
        "attributes": {"catalog_number": "VWBS-1531"}
      }
    }

上述仅演示属性落点，完整创建信封与必填值见 [载荷模板](reference-api-templates.md)。不要向当前请求添加已移除的 `types`；正式用途、媒介属性和身份依实际字段、收录与来源表达，标签不承担业务分类约束。

## kind → 种子可写属性字段

下表是源码种子的对照；实例可通过后台 GUI 调整字段 `applicable_kinds`，实际以当前生效定义为准，不靠选择展示模板改变可写范围。

| kind | `attributes` 种子字段 |
| --- | --- |
| `work` | `language`、`edition_date`、`copyright`、`imdb`、`infobox`、`events`、`duration`、`duration_source`、`author`、`volume_count`、`magazine`、`begin_date`、`end_date`、`episodes`、`platform`、`broadcast_start`、`broadcast_weekday`、`broadcast_end`、`air_network`、`tags` |
| `agent` | `tags` |
| `collection` | `language`、`tags` |
| `content_unit` | `language`、`entry_role`、`air_date`、`tags` |
| `expression` | `language`、`duration`、`version_label`、`isrc`、`events`、`tags` |
| `release` | `catalog_number`、`barcode`、`isbn`、`edition_date`、`edition_type`、`edition_batch`、`country`、`publisher`、`packaging`、`distribution_channel`、`platform`、`attachments`、`store_bonuses`、`events`、`tags` |
| `medium` | `catalog_number`、`format`、`role`、`tags` |
| `track` | `duration`、`role`、`tags` |

表中只列 attributes 的字段码。title、original_language、translations、attributes、external_ids、pictures、status、position、number 是共用实体字段；结构引用按 kind 归属，见 [载荷模板](reference-api-templates.md)。created_by、updated_at、redirect_id 是只读投影。

两个易错点：

- `duration_source` 是 **entity 字段且只能指向 `expression`**；`publisher` 是 entity 字段且只能指向 `agent`
  （不能指向 release 自己的文本名）。entity 字段要求目标实体**存在、kind 相符、对当前用户可见且未 deleted/merged**。
- `tags` 是八种实体共通的自由标签，不是受控业务分类，也不能单独证明实体身份。版本类别、发行批次、同梱物和店铺特典仍优先写到 `edition_type` / `edition_batch` / `attachments` / `store_bonuses`；标签不能代替这些结构化事实。

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

**纯字符串数组**（不是对象、不是词项码）：`["动画","剧场版"]`。当前种子允许八种 kind 写该字段。
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

键必须来自 `GET /api/catalog/external-databases` 的实际返回；外部库可由后台扩展，不以固定数量为准。未注册的键报
`invalid_external_id`。预设带 `category`（`all` / `work` / `release` / `agent`）与校验正则，常见四条：

- `official_website`：**存完整 URL**（`url_pattern` 是 `{id}`，值本身就是跳转链接，不做拼接），
  校验只要求合法 http(s) URL；`category=all`，work / release / agent 等都可写；
- `musicbrainz`：36 位 UUID（同一码被 work / release-group / recording 复用，**无语义区分**）；
- `bangumi`：纯数字；
- `isrc`：12 位码（独立码）。

**官网是"外部资料"面板的正式字段，不是只进 `sources` 的旁证。** 核到作品 / 发行 / 主体的官方站点后，
除按来源策略在 `sources` 记录它，还要把它写进 `external_ids.official_website`：前端按 `sort_order`
把官网排在面板首位并做"官方"高亮。只留在 `sources` 里页面不会出现任何官网入口——
症状是"条目有 Wikipedia / Bangumi / Steam，却没有一条官方链接"。

`steam` 预设的 category 是 `work`：写到 release 上会 400 `invalid_external_category`。
`?q=` 检索会返回 draft 实体，但 entity 型字段的引用校验要求目标可见，容易写出"看似存在却写不进去"的载荷。

## 写错时的错误码

| 现象 | 错误码 | 改法 |
| --- | --- | --- |
| 字段不适用于本 kind | `unknown_field: <码>` | 检查 `document.fields[码].applicable_kinds` 与当前实体 kind，不通过选择模板扩大白名单 |
| 枚举值不在词表 | `invalid_term`（可能带字段前缀） | 用词项代码，不提交显示名 |
| 组字段写了未声明的子键 | `unknown_field: <键>`（可能带前缀如 `locator: `） | 只写本文列出的子字段 |
| `locator` 有子字段无锚点 | `anchor_required: relative_to` | 补 `relative_to` |
| 外部 ID 键未注册 | `invalid_external_id` | 先读 `/api/catalog/external-databases` |
| 翻译形状/长度不对 | `invalid_translation` / `invalid_locale` / `translation_too_long` | locale 必须是合法语言标签，`title` 非空且 ≤2000，`aliases` 单项 ≤500 |

完整错误码表见 [API 错误码与修复动作](reference-api-errors.md)。
