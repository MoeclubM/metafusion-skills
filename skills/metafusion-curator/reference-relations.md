# 关系码、方向与属性（面向 Agent）

关系只从目标实例的 `GET /api/catalog/definitions` 取，只使用其中 `enabled` 的码；
关系码清单只从 `document.relations` 取。管理员可通过目录定义 GUI 新增、停用或修改关系并保存；
下表只是源码种子的对照，不假设目标实例已升级或记录其当前 `etag`；该标记仅防止保存覆盖，不代表可读取的历史版本。新规则与用途需同时核对 OpenAPI 支持及当前定义。
方向一律写作 `source → target`：载荷里的 `source_id` 在左、`target_id` 在右。
同 kind 端点方向写反可能仍被接受，但含义会改变；方向必须与来源核对，合法载荷不证明语义正确。

## 种子关系对照

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
| `edition_of` | 发行组归属 | 发行版本 | `release` → `work`\|`collection` | 组成 | usage=release_group；跨同用途码每个发行最多一组 |
| `expression_part` | 表达包含 | 所属整体表达 | `expression` → `expression` | 组成 | usage=expression_composition；同 Work、有序、无环 |
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

以下限制只描述这份种子快照；目标实例若已通过 GUI 启用扩展关系，按其 `document.relations` 的端点白名单判断。

- 种子关系没有 `track` 端点；管理员可按准确语义扩展，平台不禁止这些端点。
- **`medium` 只能作为 `bonus_included_in` 的 target**，不能作 source。
- **`content_unit` 永远不能作为 target**；作 source 也只能走署名类（`composed_by` / `created_by` / `credit_for` /
  `developed_by` / `directed_by` / `illustrated_by` / `lyricist_of` / `modeled_by` / `performed_by` /
  `photographed_by` / `translated_by` / `voiced_by` / `written_by`）。
- `release` 可作为 edition_of 的 source，另有 bonus/再版/署名等关系，实际端点以定义为准。
- 端点 kind 由 definitions 的白名单硬校验，越界返回 `invalid_endpoints`（自环也走这个码）。

后果（对未扩展关系的实例属于模型缺口，不要硬凑）：**"某轨的编曲者""Disc 2 的指挥""某话改编自原作第 N 话"用这些种子关系表达不了**——
按 [模型缺口与上报路径](reference-model-gaps.md) 判断 GUI 扩展范围；只有署名确实属于表达时才写在 Expression 上，不为挂署名复制内容。

## 关系属性字段

目标实例可在定义 GUI 中调整关系允许的字段；写入前以当前生效定义的 `document.relations[code].fields` 与 `document.fields` 为准。

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

属性键不在目标关系允许的 fields 内 → `unknown_field`；枚举值不在词表内 → `invalid_term`。上表为通用种子字段，新关系不保证允许全部字段。
Agent 自身可写字段以 applicable_kinds 为准；缺少主体生卒/设定时按授权扩展，不写成关系有效期或借 context 近似。

## 判重、作用域、成环与用途

1. `symmetric` 控制反向判重；种子关系为非对称。单条事实已有正反显示名，不能为反向展示再建一条边；独立反向事实也须满足无环等其他规则。
2. 普通关系按类型、端点、attributes 判重，position 不参与身份；只改 position 仍是 duplicate_relation。多角色署名用不同 character/credit_role 区分。expression_composition 另要求同一整体不能重复部分，即使换码或属性也不行。
3. `acyclic` 默认检查单码边集；声明相同非空 `cycle_group` 后，多码存活边共同检查环。未声明共同组的跨码路径不自动校验；保存、定义影响检查与合并回放使用同一规则。
4. `scope` 是同域约束：work（Work/ContentUnit/Expression）、release（Release/Medium/Track）、medium（Medium/Track）。Release.subjects 不是单值归属，不能用于推导共同 Work。不要与自由文本属性 attributes.scope 混淆。
5. `reference_scopes` 约束允许的 entity 属性，如 {"context":"source_work"}；被引用对象必须与 source 同 Work。字段目标 kind 与指定端点都需支持该域，否则定义无效。
6. `unique_position` 要求同源关系顺序唯一；expression_composition 在全部同用途码中共用顺序。release_group 的 max_outgoing=1 同样跨同用途码共同执行。其他基数按当前关系定义判断，不能假定所有关系无限制。

expression_composition 必须是 expression→expression、scope=work、acyclic=true、cycle_group=expression_composition、aggregate=true、unique_position=true、symmetric=false；release_group 必须是 release→work/collection、max_outgoing=1、symmetric=false。管理员可在 GUI 选择用途自动填入必要规则，再做影响检查。关系码与名称可扩展，用途执行语义仍受服务端支持范围限制。

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
      "sources": [{"kind": "url", "citation": "官方片尾字幕：支持 voiced_by、source_id、target_id、character、language", "url": "https://example.org/credits"}]
    }

- 新建：`POST /api/catalog/relations`，`expected_version` 为 0；`Idempotency-Key` 持久 24h，同键同载荷重放、异载荷 `409 idempotency_conflict`。
  更新：`PUT /api/catalog/relations/{id}`，必须先从实体 relations 回读完整关系与版本。关系成功响应后也要回读关系集合。
- 删除：`DELETE /api/catalog/relations/{id}` **必须带 body**：`{"expected_version": <回读到的 version>, "edit_note": …, "sources": […]}`。
  不带版本 → `409 version_conflict`；完全不带 body → `400 invalid_payload`。删除同样要证据。
- 关系的版本号从 `GET /api/catalog/entities/{id}/relations` 的返回项里取（该响应含 `subject_id` 与对端 `entities`，单条关系的 GET 只有这一个来源）。
- 关系只是一条修订证据载荷，不自动获得 CORE-P1 资格；普通辅助关系可用 P2，但用于作者、改编、系列归属或唯一身份锚点时，边和两端都须 P1。
- 被引用实体必须存在、kind 相符、对当前用户可见且未 `deleted` / `merged`，否则 `invalid_reference`；
  `?q=` 能搜到 draft，但 draft 不能作为公开条目的引用目标。

常见拒绝码：`invalid_relation_type`、`invalid_endpoints`（含自环）、`relation_cycle`、`duplicate_relation`、
`constraint_violation`、`evidence_required`。完整表见 [API 错误码与修复动作](reference-api-errors.md)。
