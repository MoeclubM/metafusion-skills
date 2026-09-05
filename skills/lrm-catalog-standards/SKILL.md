---
name: lrm-catalog-standards
description: 按 MetaFusion 的 LRM 分层和真实发行证据命名 Work、CanonicalEntry、Release、Medium、Track 与 TrackContent。用于新建、补录、迁移、查重和审核跨媒介作品及发行版。
---

# MetaFusion LRM 与发行版规范

本技能专注于“创作母体是什么”和“某个发行版如何承载它”的边界。全站编目流程、审查结论格式和当前 API 差异见 [metafusion-curator](../metafusion-curator/SKILL.md)；使用前先读其 [当前实现契约](../metafusion-curator/reference-runtime-contract.md)。

## LRM 层级

| 层级 | 语义 | 典型字段 |
| --- | --- | --- |
| Work | 纯净的创作母体，不等于某个版本 | title、original_title、original_language、summary、tags |
| CanonicalEntry | Work 下可复用的表达、母版、分集、章节或目录项 | work_id、title、position、number、entry_role、version_label |
| Release | 该 Work 的一个真实商业发行或出版版本 | work_id、edition_name、edition_date、publisher_id、catalog_number、barcode、packaging |
| Medium | Release 内真实存在的盘、卷、文件集或其他容器 | release_id、position、name、format、media_category、role |
| Track | Medium 内的物理位置项 | medium_id、position、title、duration_seconds、ISRC、locator |
| TrackContent | Track 在某位置收录的 CanonicalEntry | track_id、canonical_entry_id、position、locator |

AssetFile 属于独立的资产注册/绑定层。文件哈希、对象存储键和处理状态不应回写到作品题名或发行版名称。

## 命名和归属规则

1. Work 只写创作主名。TV、OVA、剧场版、Season、Vol、S1、4K、1080p、FLAC、OST、初回限定、BOX、出版社和品番等版本或包装信息，放到 Release / Medium / Track 或受控标签与关系中。若来源确实是独立创作实体，先判断实体边界再新建 Work。
2. CanonicalEntry 表达内容或母版本身，不带专辑名、盘号、卷号和发行品番。内容目录的父子关系只能在同一 Work 内。
3. Release 必须有可核实的版本差异。edition_name 使用官方版名或能明确区分版本的描述；条码、品番、日期、包装、出版者和发行渠道填入独立字段，不要捏造占位发行版。
4. Medium 只表示包装中真实存在的容器。position 以官方目录或实物顺序为准，format、media_category、role 使用实例的 taxonomy 词表。
5. Track 是容器位置。单内容旧字段 canonical_entry_id 与多内容 contents 可兼容读取，但不可互相矛盾；多内容时用 TrackContent.position 和 locator 记录收录顺序与页码、章节或时间段。
6. 当前 000006_carrier_content_integrity 要求 Track / TrackContent 与 Release.work_id 同 Work。不要提交外部 Work ID，也不要用直接 SQL 规避检查。

## 多作品盒装的处理

一个 Release 当前只有一个 work_id，因此当前实现无法把同一个物理盒装的多个独立 Work 安全地展开到同一组 Track。不得把全集品番挂到其中一部作品，也不得照搬旧的跨 Work Track 示例。

遇到多作品盒装时：

- 先核对实例是否有明确支持 Compilation / 汇编的实体或端点；
- 有明确支持时，按该实例的 OpenAPI 和迁移建模，并保留每个分碟的实际证据；
- 没有明确支持时，保留每部作品已核实的独立发行信息，把盒装物理映射标为模型缺口；不要填入近似的 Work、Track 或关系。

## 跨发行复用

同一 Work 内的 CanonicalEntry 可以被多个该 Work 的 Release 通过 Track 或 TrackContent 引用。创建前先按 ISRC、ISBN、原题名、章节号和内容证据查重。跨 Work 的相似标题、翻译或改编不是复用理由，应通过受控 EntityRelationship 表达。

## 编目检查

- 作品题名不包含版本污染词，且别名没有把版本名伪装成主名；
- Release 具有来源支持的 edition、日期、厂牌/出版者、条码或品番；
- Medium 数量和 Track 顺序与真实包装一致；不存在虚构盘片；
- CanonicalEntry、Track 和 TrackContent 的 Work 归属一致，parent_id 不越界；
- 章节/分集/曲目等内容只在有来源时创建，不从“有几本书”推造章节；
- 关系类型与端点类型来自实例 relation-types，层级边没有自环或闭环；
- 翻译形状和回退链符合当前实现契约，封面比例与真实图像相符；
- 写入携带具体 edit_note 和相关 source_urls，并在写后读取 revisions 验证。

## 参考

- [metafusion-curator](../metafusion-curator/SKILL.md)
- [当前实现契约](../metafusion-curator/reference-runtime-contract.md)
- [LRM 架构参考](../metafusion-curator/reference-lrm-architecture.md)
- [质量检查清单](../metafusion-curator/reference-qa-checklist.md)
