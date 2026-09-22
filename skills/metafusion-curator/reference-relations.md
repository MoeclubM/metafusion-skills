# 关系码、方向与属性（面向 Agent）

关系只从目标实例的 `GET /api/catalog/definitions` 取，只使用其中 `enabled` 的码；
关系码清单只从 `document.relations` 取。管理员可通过目录定义 GUI 新增、停用或修改关系后发布；
下表只是种子定义（`base_version=7`）的 29 条快照，
方向一律写作 `source → target`：载荷里的 `source_id` 在左、`target_id` 在右。
方向写反不会报错，但会把事实写成另一个意思——这是关系数据最常见的错误来源。

## 种子定义的 29 条关系

| 码 | 正向名 | 反向名 | source → target | 组 | 语义边界 |
| --- | --- | --- | --- | --- | --- |
| `adaptation_of` | 改编自 | 被改编为 | `work` → `work` | 创作 | acyclic |
| `alternate_take_of` | 别版取自 | 被用作别版 | `expression` → `expression` | 创作 | acyclic |
| `arranged_by` | 编曲者 | 编曲了 | `work`\|`expression` → `agent` | 署名 | |
| `bonus_included_in` | 特典收录于 | 收录特典 | `expression` → `release`\|`medium` | 组成 | acyclic。**medium 只能在这里当 target** |
| `character_in` | 角色登场 | 登场角色 | `agent` → `work`\|`collection` | 署名 | 角色是多作品出场就建多条 |
| `composed_by` | 作曲者 | 作曲了 | `work`\|`content_unit`\|`expression` → `agent` | 署名 | |
| `cover_of` | 翻唱自 | 被翻唱为 | `expression` → `expression` | 创作 | acyclic。只连 expression，不连 work |
| `created_by` | 创作者 | 创作了 | `work`\|`content_unit`\|`expression`\|`release` → `agent` | 署名 | |
| `credit_for` | 参与制作 | 署名人员 | `work`\|`content_unit`\|`expression`\|`release` → `agent` | 署名 | 任意职位用 `credit_role` 文本承载 |
| `developed_by` | 开发者 | 开发了 | `work`\|`content_unit`\|`expression`\|`release` → `agent` | 署名 | |
| `directed_by` | 导演 | 执导了 | `work`\|`content_unit` → `agent` | 署名 | |
| `illustrated_by` | 插画者 | 绘制了 | `work`\|`content_unit`\|`release` → `agent` | 署名 | |
| `includes` | 组成包含 | 组成属于 | `collection`\|`work` → `work`\|`collection` | 组成 | acyclic + aggregate。专辑→曲目、系列→作品都用它 |
| `lyricist_of` | 作词者 | 作词了 | `work`\|`content_unit`\|`expression` → `agent` | 署名 | |
| `member_of` | 所属团体 | 成员 | `agent` → `agent` | 组成 | acyclic。语义是"所属团体"，不是角色关系 |
| `modeled_by` | 出镜者 | 出镜于 | `work`\|`content_unit`\|`expression`\|`release` → `agent` | 署名 | |
| `narrated_by` | 朗读 / 旁白 | 朗读了 | `expression`\|`release` → `agent` | 署名 | |
| `performed_by` | 表演者 | 表演了 | `work`\|`content_unit`\|`expression`\|`release` → `agent` | 署名 | 演奏/演唱 |
| `photographed_by` | 摄影者 | 拍摄了 | `work`\|`content_unit`\|`expression`\|`release` → `agent` | 署名 | |
| `pressing_of` | 再版自 | 被再版为 | `release` → `release` | 创作 | acyclic。**是"再版/复刻"，不是"收录"** |
| `revision_of` | 修订自 | 被修订为 | `expression` → `expression` | 创作 | acyclic |
| `sequel_of` | 续作于 | 作为前作 | `work` → `work` | 创作 | acyclic |
| `soundtrack_of` | 配乐用于 | 配乐作品 | `work` → `work` | 创作 | acyclic。OST → 被配乐的作品 |
| `spin_off_of` | 外传自 | 衍生出 | `work` → `work` | 创作 | acyclic |
| `store_bonus_for` | 渠道特典归属 | 拥有渠道特典 | `expression`\|`release` → `agent` | 组成 | acyclic。**target 是店铺主体，不是发行版本** |
| `translated_by` | 译者 | 翻译了 | `work`\|`content_unit`\|`expression` → `agent` | 署名 | |
| `translation_of` | 翻译自 | 被翻译为 | `expression` → `expression` | 创作 | acyclic |
| `voiced_by` | 配音者 | 配音于 | `work`\|`content_unit`\|`expression`\|`release` → `agent` | 署名 | 常配 `{character, language}` |
| `written_by` | 编剧 | 编写了 | `work`\|`content_unit` → `agent` | 署名 | |

这份种子快照使用三个组：`creative`（创作关系）、`credits`（署名）、`membership`（组成与成员）。

## 种子定义的端点 kind 约束

以下限制只描述这份种子快照；目标实例若已发布扩展关系，按其 `document.relations` 的端点白名单判断。

- **`track` 不能作为任何关系的 source 或 target**（29 条里 0 条）。
- **`medium` 只能作为 `bonus_included_in` 的 target**，不能作 source。
- **`content_unit` 永远不能作为 target**；作 source 也只能走署名类（`composed_by` / `created_by` / `credit_for` /
  `developed_by` / `directed_by` / `illustrated_by` / `lyricist_of` / `modeled_by` / `performed_by` /
  `photographed_by` / `translated_by` / `voiced_by` / `written_by`）。
- `release` 只出现在 `bonus_included_in`（target）、`pressing_of`（两端）、署名类（source）。
- 端点 kind 由 definitions 的白名单硬校验，越界返回 `invalid_endpoints`（自环也走这个码）。

后果（对未扩展关系的实例属于模型缺口，不要硬凑）：**"某轨的编曲者""Disc 2 的指挥""某话改编自原作第 N 话"用这些种子关系表达不了**——
按 [模型缺口与上报路径](reference-model-gaps.md) 报告，可用的近似是把署名挂到为该轨/该话新建的 `expression` 上。

## 种子关系的属性字段（29 条均允许下列 9 个字段）

目标实例可在定义 GUI 中调整关系允许的字段；写入前以已发布定义的 `document.relations[code].fields` 与 `document.fields` 为准。

| 字段 | 类型 | 用法 |
| --- | --- | --- |
| `role` | enum `role` | `primary` / `side` / `extra` / `supplement` / `commentary` |
| `credit_role` | text | **职位原文**（"音楽""Animation Production"…），任意署名关系的自由文本落点 |
| `character_rank` | enum `character_rank` | `main` / `supporting` / `guest` / `ensemble` / `narrator` / `cameo` |
| `character` | entity → **`agent`** | 配音/出演的角色（角色本身也是 agent） |
| `context` | entity → `work`\|`content_unit`\|`expression`\|`release` | 该署名适用于哪部作品/哪个篇目 |
| `language` | text | 该署名对应的语言版本（`ja` / `zh-CN`…） |
| `begin_date` / `end_date` | date | 任期/期间（"某人在某团体期间"只能落在这里） |
| `scope` | text | 适用范围说明的自由文本 |

惯例两例：

    // 声优：同时给出角色与语言版本
    {"type": "voiced_by", "source_id": "<work-or-expression>", "target_id": "<cv-agent>",
     "attributes": {"character": "<character-agent>", "language": "ja"}}

    // 登场角色的番位
    {"type": "character_in", "source_id": "<character-agent>", "target_id": "<work>",
     "attributes": {"character_rank": "main"}}

属性键不在上表内 → `unknown_field`；枚举值不在词表内 → `invalid_term`。
**agent 实体自己没有属性字段**，所以人物生卒、团体成立日、角色设定只能用关系边上的
`begin_date` / `end_date` / `context` 近似，或按模型缺口上报。

## 多边、反向边、成环与基数（与直觉不同的四点）

1. **反向边是否判重由 `symmetric` 决定**：只有声明 `symmetric=true` 的关系才检查"反向重复边"，而种子 29 条**全部
   `symmetric=false`**。A→B 与 B→A 同类型的两条边都合法——需要双向语义时就建两条，不要以为服务端会拦。
2. **区分同类多边要用 `attributes`，不是 `position`**：应用层判重键含 `position`，但数据库唯一索引
   `(source_id, target_id, type, attributes)` **不含 position**；只靠 `position` 区分的两条边会撞唯一索引，
   报 `constraint_violation` 而不是 `duplicate_relation`。同一人物配多个角色请用不同 `character` / `credit_role`。
3. **成环检测只在同一关系码的边集内进行**：跨码的长路径环（`adaptation_of` + `sequel_of`…）服务端看不见，
   所以"写入成功"不等于全库 DAG 成立。审查结论请限定在已复核的局部。
4. **种子关系未设置基数限制**：29 条关系的 `max_outgoing` / `max_incoming` 全为 `0`，
   `cardinality_exceeded` 与 `invalid_endpoint_types`（`source_types` / `target_types` 全为 `null`）
   在这份种子定义下**无法触发**；目标实例若已扩展，须重新判断。

## 载荷与端点

    POST /api/catalog/relations
    {
      "relation": {
        "type": "voiced_by",
        "source_id": "<work-uuid>",
        "target_id": "<agent-uuid>",
        "position": 0,
        "attributes": {"character": "<character-uuid>", "language": "ja"}
      },
      "expected_version": 0,
      "edit_note": "官方片尾字幕",
      "sources": [{"kind": "url", "citation": "官方片尾字幕", "url": "https://example.org/credits"}]
    }

- 新建：`POST /api/catalog/relations`，`expected_version` 为 0，支持 `Idempotency-Key`；
  更新：`PUT /api/catalog/relations/{id}`。
- 删除：`DELETE /api/catalog/relations/{id}` **必须带 body**：`{"expected_version": <回读到的 version>, "edit_note": …, "sources": […]}`。
  不带版本 → `409 version_conflict`；完全不带 body → `400 invalid_payload`。删除同样要证据。
- 关系的版本号从 `GET /api/catalog/entities/{id}/relations` 的返回项里取（该响应含 `subject_id` 与对端 `entities`，单条关系的 GET 只有这一个来源）。
- 被引用实体必须存在、kind 相符、对当前用户可见且未 `deleted` / `merged`，否则 `invalid_reference`；
  `?q=` 能搜到 draft，但 draft 不能作为公开条目的引用目标。

常见拒绝码：`invalid_relation_type`、`invalid_endpoints`（含自环）、`relation_cycle`、`duplicate_relation`、
`constraint_violation`、`evidence_required`。完整表见 [API 错误码与修复动作](reference-api-errors.md)。
