# MetaFusion 编目质检清单

按目标实例的 OpenAPI、taxonomy、relation-types 和 [当前实现契约](reference-runtime-contract.md) 执行。未执行的项目标记为“未核验”，不要写成已通过。

## 身份与查重

- [ ] 已按原题名、原文题名、别名、条码、品番和外部 ID 查重。
- [ ] 已证明这是新的 Work，或明确说明为何复用已有 Work。
- [ ] Work 题名没有季数、卷号、盘号、规格、画质、音质、包装、出版社或字幕组污染。
- [ ] 别名和外部 ID 没有把另一版本伪装成独立创作实体。

## 层级和归属

- [ ] CanonicalEntry 属于正确 Work，parent_id 指向同一 Work；已有篇目没有被迁移到别的 Work。
- [ ] Release 属于一个 Work，版名和字段来自真实发行证据。
- [ ] Medium 属于正确 Release；数量、position、format、media_category 和 role 与包装一致。
- [ ] Track 属于正确 Medium；position 唯一且 title / duration_seconds / ISRC / locator 与来源一致。
- [ ] TrackContent 的 canonical_entry_id 都属于 Track 所属 Release 的同一 Work，position 不冲突，locator 有实际定位意义。
- [ ] legacy canonical_entry_id 与 contents 没有互相矛盾。
- [ ] AssetFile 的哈希、对象键和处理状态位于资产层，没有污染内容题名。

## 盒装与合集

- [ ] 单部 Work 没有挂载多作品全集的 catalog_number 或 barcode。
- [ ] 已核对实例是否支持 Compilation / 汇编模型。
- [ ] 如果不支持跨 Work Track / TrackContent，已将物理盒装映射标为模型缺口，没有用 SQL 或伪造 work_id 绕过。
- [ ] 没有从卷数、盘数或发行数量推造未被来源证明的 CanonicalEntry。

## 关系图

- [ ] 关系类型已从 relation-types 读取且处于启用状态。
- [ ] source / target 实体真实存在且端点类型被允许。
- [ ] 没有自环、错误反向边或把同一人物拆成多个实体。
- [ ] 同一对实体的同类多边使用 qualifier；时间字段符合 relation type 的语义。
- [ ] 层级关系没有闭环。对大出度、并发写入或已知实现限制，已在报告中说明“仅完成局部核验”。

## 翻译和封面

- [ ] Work / Artist / Franchise 的翻译数组使用合法 locale、题名和简介字段。
- [ ] Release / Medium / Track / CanonicalEntry 使用当前实现契约规定的 JSON 对象形状，没有把数组形状跨层复制。
- [ ] 回退顺序为请求 locale → en-US → original_language → 基础字段。
- [ ] 标签、角色、关系类型、格式和包装名称来自 taxonomy / relation-types 的多语言结果。
- [ ] cover_aspect 与图片真实比例匹配。当前实例允许 1:1、2:3、3:4、4:3 或自动推断；前三种只是常用建议。
- [ ] 封面来自可核实的官方或授权来源，无占位图、拉伸和水印；外部 URL 已通过实例安全校验。

## 审计和写后验证

- [ ] 每次变更都有具体 edit_note 和相关 HTTP(S) source_urls。
- [ ] 已确认目标端点是否真正保存 revision 和 admin audit；不能从接口成功响应推断审计完整。
- [ ] 已重新读取写入实体及其父子关联。
- [ ] 已检查 revisions 中的 before / after / diff、编辑者、来源和状态。
- [ ] 报告将结果归类为通过、需补证据、需修正或实现缺口，并列出实体和字段。
