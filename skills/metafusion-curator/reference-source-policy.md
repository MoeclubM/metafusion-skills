# 字段级来源、当前版本与封面权利策略

本页定义编目事实的证据门槛。来源等级按**字段与结论**判定，不按网站整站判定；同一页面明示的辅助字段可用，未经核实的其它字段仍为空。

## 三层来源与禁用项

- **CORE-P1（核心可采信）**：权利方、出版/发行/制作方、作者或艺人官方页；官方目录、产品页、新闻稿、press kit、字幕/署名；官方 ISBN/ISRC/GS1 等注册机构；以及明确提供该具体版次数据的官方或授权销售渠道。P1 只支持页面实际明示的字段。
- **AUX-P2（辅助）**：MusicBrainz、Wikidata、Discogs、VGMdb、Bangumi、AniList、MAL、IMDb、TMDB、百科与社区站。可发现候选、交叉核对或记录辅助事实；**不得单独满足核心字段、实体边界、合并或计数门槛**。
- **DISCOVERY-W（Wiki/线索）**：只作检索与交叉核对，不直接支撑写入值。Wiki 引用的原始来源要另行定位、打开并按字段登记。
- **禁用证据**：模型记忆、搜索结果摘要、站内旧值/自证、无可点开依据的 `self`、粉丝站或社区转述。P1 冲突时保留待核状态，不静默择一。

## 核心与辅助字段矩阵

| 字段或结论 | 默认等级 | 升级/通过条件 |
| --- | --- | --- |
| `kind`、`types`、父级作用域、`subjects` / `contents` 的发行归属 | CORE-P1 | 官方作品/产品/目录/TOC/版次记录；P2 只能给候选，不能据此新建、合并或计数 |
| 基础 `title`、官方版名、正式名称 | CORE-P1 | 官方作品页、产品页、发行目录或注册记录；译名不能代替正式题名 |
| `translations[locale].summary` | CORE-P1 | 权利方/制作方的一手简介或官方新闻稿；翻译只能忠实转述，不得由模型扩写 |
| `catalog_number`、`isbn`、`barcode` | CORE-P1 | 出版/发行方目录、官方商品页、授权销售渠道或官方注册记录，并逐字对应具体版次 |
| `external_ids`、ISRC、平台 ID 等身份锚点 | CORE-P1（一旦用于身份/去重） | 官方平台、权利方或官方注册记录；解析到正确 kind、类型与作用域 |
| `number`、`position`、`locator` 等目录/版次锚点 | CORE-P1（用于识别或去重时） | 官方目录、liner notes、字幕、包装或实物资料 |
| `pictures` | 独立硬门 | 同时具备官方/权利方图像来源，以及覆盖本服务展示、复制或热链的明确许可/授权；详见下文 |
| 日期、`duration`、`language`、`copyright`、`tags`、`format`、`packaging`、`region` | AUX-P2 | 若用于区分、合并或去重，立即升级为 CORE-P1 |
| 关系/署名 | AUX-P2 | 若用于作者、改编、系列归属或唯一身份锚点，则关系边及两端都须 CORE-P1 |
| 译名、`aliases` | AUX-P2 | 官方本地化页优先；不能替代基础题名或单独成为身份锚点 |
| `id`、`version`、`created_by`、`updated_at` | 非事实证据 | 只作系统定位、并发或审计信息 |

P1 与 P2 冲突时，不让聚合站覆盖官方值；记录冲突并交人工核验。找不到合格原始来源时留空，不能用相邻实体或近似值补齐。

## 当前版本的来源审计

目录的 `sources` 位于**修订记录**，不在 Entity 顶层，也不是字段级 provenance。一次合格审计必须：

1. `GET /api/catalog/entities/{id}` 取得当前实体与 `version`；
2. `GET /api/catalog/entities/{id}/revisions`，只选 `revision.version == entity.version` 的当前修订；
3. 逐条打开来源，核对它实际支持的字段码、实体作用域和具体版次；`citation` 应明确列出所支持字段；
4. 把每个 CORE-P1 字段映射到当前修订的具体来源；历史修订、已失效来源和 `self` 不补当前资格；
5. 核心字段缺一即为“需补证据 / 不计完整 / 不得进入试点计数”，辅助字段缺失或仅有 P2 不得掩盖核心缺口。

服务端接受 `sources` 只证明载荷形状合格，不证明来源权威或内容已核实。现有值缺 P1 时按实体保留规则不擅自删除，但必须标记“需补证 / 不计数”；不要以站内旧值或不合规来源洗白。

## 封面与图片权利证据包

`Picture` 只有 `url`、`caption`、`taken_at` 和 `source`；`Source` 只有 `kind`、`citation`、可选 `url`。DTO 没有 `asset_id`、许可类型、授权范围或期限。**官方 URL 只证明图源，不自动授权 FindVerse 复用。**

封面进入可计完整状态前，另存审查证据包，至少包含：

- `entity_id` / `kind` 与图片、资产或原始文件标识；
- 原始页面或文件 URL、页面位置、原件哈希、获取时间；
- 出示主体及其角色（权利方、发行方或被授权素材库）；
- `rights_basis`：权利方发布条款、明确开放许可或书面授权；
- 授权方、被授权方、允许用途、展示方式、地域、期限，以及是否允许裁切/改色；
- 许可/合同证据 URL 或合同引用、审查时间、审查人、`rights_review`。

`rights_review` 只能是 `passed` 或 `blocked`。来源、模型记忆、搜索摘要、`pictures[].source` 或普通实体 `sources` 都不能代替授权。许可缺失、用途不覆盖本服务、权利主体无法确认或素材仅“官方可访问”时，一律 `blocked`、不使用、不计数。

## 试点与批次判定

逐实体输出 `core_evidence_ok`、`cover_rights_ok`、`canonical_id`、`count_eligible` 与缺口列表。只有当前版本所有核心字段均有 P1、封面权利审查通过、实体边界与去重均确认时才可 `count_eligible=true`；P2/Wiki 数量、Agent/Collection 等支持实体数量和“接口返回 200”都不能代替核心完整性。
