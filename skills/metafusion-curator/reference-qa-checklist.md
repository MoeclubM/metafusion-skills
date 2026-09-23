# MetaFusion 编目质检清单

按目标实例的 `GET /api/openapi.json`、`GET /api/catalog/definitions` 和
[API 行为参考](reference-api-behavior.md) 执行。未执行的项目标记为"未核验"，不要写成已通过。

## 身份与查重

- [ ] 已按 kind + 原题名、原文题名、别名、条码、品番和外部 ID 查重，且核对了 **`types` + 父级作用域**（同名同 kind 但类型码不同是两个实体，如电影本体与其 OST 专辑）。
- [ ] 已证明这是新的 Work，或明确说明为何复用已有 Work。
- [ ] Work 题名没有季数、卷号、盘号、规格、画质、音质、包装、出版社或字幕组污染。
- [ ] 别名和外部 ID 没有把另一版本伪装成独立创作实体。
- [ ] 责任主体落在 `agent`（没有沿用旧的 `artist` / `franchise` 实体名）。

## 层级与归属

- [ ] `content_unit` / `expression` 属于正确 Work；`content_unit` 的 `parent_id` 指向同一 Work。
- [ ] `expression` 没有误填 `parent_id`（该 kind 只允许 `work_id` 与 `content_unit_id`）。
- [ ] `medium` 属于正确 Release，`track` 属于正确 Medium；曲序与包装一致。
- [ ] 每个实体都声明了正确的 `types`（`attributes` 的每个键都在该实体 types 的字段并集里；`agent` 的 `attributes` 为空；不声明类型就只能写空 `attributes`）。
- [ ] `release` 上没有 `work_id`，且 `subjects` **覆盖了它实际收录表达的全部 Work**。
- [ ] `subjects[].role` 取自 `release_role` 词表（`primary` / `compilation` / `supplement`），
      同一 `(work_id, role)` 没有重复。
- [ ] `track.contents` 的 `expression_id` 都真实存在且可见；`contents` 数组内 `position` 不重复（这是 `duplicate_position` 唯一管的范围；同一 medium 下兄弟 track 的 position 服务端不做唯一校验，不要当成错误去“修复”）。
- [ ] 同一 Expression 在同一 Track 的多次出现确实对应不同 locator（相同 expression + 相同 locator 属重复收录）。
- [ ] 字段名只用当前 DTO 的：单内容引用走 `contents`、发行版名用 `title`、封面走 `pictures`。
- [ ] 文件哈希、对象键与下载地址位于存储服务，没有污染题名或动态字段。

## 盒装与合集

- [ ] 单部 Work 没有挂载多作品全集的品番或条码。
- [ ] 多作品盒装的 `subjects` 覆盖实际收录表达所属的全部 Work；只有来源支持时才另建汇编 Work，没有伪造 `work_id` 或改库绕过校验。
- [ ] 系列/企划世界观用 `collection` + `includes` 表达，没有为作者个人作品全集硬建企划。
- [ ] 没有从卷数、盘数或发行数量推造未被来源证明的 `content_unit` / `expression`。

## 关系图

- [ ] 关系类型取自 `GET /api/catalog/definitions` 的 `relations` 且处于启用状态
      （关系码清单只从 `definitions` 的 `document.relations` 取）。
- [ ] source / target 实体真实存在，且各自的 kind 与业务类型在该关系允许范围内。
- [ ] 没有自环、错误反向边或把同一人物拆成多个实体。
- [ ] 同一对实体的同类多边用 `attributes` 区分（如声优多角色用不同 `character` 的多条 `voiced_by`）；**只改 `position` 无效**，会撞唯一索引报 `constraint_violation`（`position` 不在服务端去重键里）。
- [ ] 需要双向语义时建了两条边（反向边不自动判重：当前定义全非 `symmetric`，不要把“没见到拒绝”当成判重）。
- [ ] 声明为 acyclic 的层级关系没有闭环；大出度或并发写入场景下只声明"局部已核验"。

## 翻译与封面

- [ ] 所有实体的 `translations` 都是**对象**（按 locale 分组，含 `title` / `summary` / `aliases`），
      跨 kind 保持同一对象形状。
- [ ] 回退顺序为请求 locale → `en-US` → `original_language` → 基础 `title`，展示值没有回写基础题名。
- [ ] 发布的实体至少有一条翻译（否则服务端返回 `translation_required`）。
- [ ] 标签、角色、关系类型、载体格式等代码来自 definitions / 词表，没有硬编码术语。
- [ ] `pictures[].url` 是绝对 HTTP(S) 地址（相对路径会被判 `invalid_picture`），`source` 指向并说明具体图源；封面优先使用权利方/出版发行方提供的高清原图，已核对并记录许可或明确授权依据（官方来源本身不等于再利用许可）。权利不明时不使用、留空并报告；无占位图、拉伸、裁切伪装或水印。
- [ ] 画幅比例若写入，位于实例定义声明的字段下；没有提交顶层 `cover_aspect`。
- [ ] 动过定义/货架/外部库名称的：`names` 四语齐备（`zh-CN` / `zh-TW` / `en-US` + `ja` 或 `ja-JP`），否则 `four_locale_names_required`（这是 `names`，与实体 `translations` 两套形状）。

## 证据、并发与写后验证

- [ ] 每次变更都有具体 `edit_note` 和至少一个 `sources` 项（`kind` 为 `url` / `publication` / `self`）。
- [ ] 更新前已 GET 完整实体并带回未修改字段（PUT 是整实体替换，不是局部 PATCH）。
- [ ] 更新带了正确的 `expected_version`；409 `version_conflict` 时已回读再重放。
- [ ] 已重新读取实体、`relations`、`occurrences` 与 `revisions`。
- [ ] 已核对 revisions 行的 `snapshot`（写后快照）与当前实体、编辑者与来源，确认未请求修改的数据没有丢失（注意：`revisions` **没有 before/after 字段**，只能拿快照比对）。
- [ ] 没有声称这些接口提供全量事务或全库 DAG 证明——结论限定在本次写入与已复核的局部。
- [ ] 报告将结果归类为通过、需补证据、需修正或实现缺口，并列出实体和字段。
