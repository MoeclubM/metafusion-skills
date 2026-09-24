---
name: lrm-catalog-standards
description: 按 MetaFusion 的 LRM 分层和真实发行证据命名 Agent、Collection、Work、ContentUnit、Expression、Release、Medium 与 Track。用于新建、补录、迁移、查重和审核跨媒介作品及发行版。
---

# MetaFusion LRM 与发行版规范

本技能专注于"创作母体是什么"和"某个发行版如何承载它"的边界。
全站编目流程、审查结论格式和当前 API 差异见 [metafusion-curator](../metafusion-curator/SKILL.md)；
使用前先读其 [API 行为参考](../metafusion-curator/reference-api-behavior.md)和
[字段级来源、当前版本与封面权利策略](../metafusion-curator/reference-source-policy.md)。

实体边界、正式题名、类型与作用域、发行归属、官方编号、ISBN/条码及用于去重的外部 ID 都属于核心事实，必须有逐字段 CORE-P1 证据；P2/Wiki 只能发现候选或记录辅助事实，不能据此新建、合并或计入完整。

## 固定实体骨架

| kind | 语义 | 典型字段 |
| --- | --- | --- |
| agent | 责任主体：个人、组织、团体、虚构角色（**四类类型都没有属性字段**，`attributes` 必须为空） | title、original_language、types、translations |
| collection | 系列 / 企划 / 世界观聚合枢纽 | title、translations、`types:["collection"]`；唯一可用属性是 `attributes.language`，聚合靠 `includes` 关系 |
| work | 纯净的创作母体，不等于某个版本 | title、original_language、types、attributes.tags、translations、pictures |
| content_unit | 同 Work 内的逻辑章 / 集 / 篇目目录 | work_id、parent_id、title、number、position |
| expression | 可复用的表达：母版、正片、录音、译本 | work_id、content_unit_id、title、position |
| release | 该发行收录内容的一个真实商业发行版本 | title、subjects、品番/条码/日期等动态字段 |
| medium | 发行内真实存在的盘、卷、文件集或其他容器 | release_id、parent_id、title、position、载体规格字段 |
| track | Medium 内的物理位置项 | medium_id、parent_id、title、position、contents[] |

没有独立的 `artist` / `franchise` 实体：创作者与机构落 `agent`，系列与世界观落 `collection`。
物理文件不属于元数据：文件、哈希与绑定由存储服务管理，见
[文件上传与绑定](../metafusion-curator/reference-file-upload.md)。

## 命名和归属规则

1. Work 只写创作主名。只有官方作品/产品/发行资料证明某个 TV、OVA、剧场版、Season、Vol、S1、4K、1080p、FLAC、OST、初回限定、BOX
   是独立创作实体时，才先按来源判断边界再新建 Work；不得从正式题名机械删词或按 Wiki/聚合站拆建。版本、出版社和品番等放入有 P1 证据的 Release / Medium / Track 或关系中。
   注意 `attributes.tags` **只有 work 能写**：不要把"初回盘""活动限定"这类标签往 Release / Medium / Track 上塞——那里没有 tags 字段（`unknown_field`），
   改用实例 definitions 声明的 `edition_type` / `edition_batch` / `attachments` / `store_bonuses`，写不下的按实现缺口上报。
2. ContentUnit 表达的是**目录**（第几话、第几章、第几卷的篇目），不带专辑名、盘号和发行品番；
   父子关系只能在同一 Work 内。
3. Expression 是可被多个发行复用的那一层（录音母版、正片、正文、译本）。
   它可以有 `content_unit_id`，但**没有 `parent_id`**；不要把它当目录树用。
4. Release 必须有可核实的版本差异。版名用官方版名或能明确区分版本的描述；
   条码、品番、日期、包装、发行者填入实例 definitions 声明的字段，不要捏造占位发行版。
   **Release 没有独占 `work_id`**，它用 `subjects` 声明收录的 Work。
5. Medium 只表示包装中真实存在的容器，position 以官方目录或实物顺序为准；
   载体规格字段码使用实例词表。
6. Track 是容器位置。收录通过 `contents[].expression_id` + `position` + `locator` 表达；
   单内容引用走 `contents`。同一 Track 内 position 唯一，
   同一 expression 只有 locator 完全相同时才算重复收录。

## 多作品盒装的处理

跨作品收录是**受支持的一等能力**：

1. 只有来源证明汇编本身是独立创作母体时才建立汇编 Work；
2. 给盒装发行写 `subjects`，覆盖实际收录表达所属的全部 Work；角色从实例 `release_role` 词表选，缺准确角色时报告缺口；
3. 各分碟的 Medium / Track 用 `contents` 收录各作品自己的 Expression。

服务端会校验 `undeclared_release_subject`：任一收录表达的 Work 未在该发行的 `subjects` 中声明即拒绝保存。

**严禁反例**：把全集品番填到其中一部作品的单碟发行上；伪造 `work_id`；用直接 SQL / 改触发器绕过校验。

## 跨发行复用

同一 Expression 可以被多个 Release 的 Track 重复收录，从而支持"收录于哪些版本"的反查
（`GET /api/catalog/entities/{id}/occurrences`）。
创建前先按 ISRC、ISBN、原题名、章节号和内容证据查重。
跨 Work 的相似标题、翻译或改编不是复用理由，应通过受控关系
（`adaptation_of` / `sequel_of` / `soundtrack_of` 等）表达。

## 类型、字段与关系：以 curator 的三份参考为准

- 每个实体都要声明 `types`；它决定 `attributes` 的可写字段。各 kind 字段白名单见[类型码、字段白名单与结构化字段](../metafusion-curator/reference-types-and-fields.md)。
- **种子关系码为 29 条**，方向与端点见 [关系码、方向与属性](../metafusion-curator/reference-relations.md)；实例可由管理员在定义编辑器中增改并发布，以已发布定义为准。
  重点记三条：`pressing_of` 是 release→release 的"再版"（不是收录）；`bonus_included_in` 是
  expression→release|medium 的"特典收录于"；`store_bonus_for` 的 target 是**店铺主体 agent**，不是发行版本。
  种子定义中 `track` 不能作任何关系端点，`medium` 只能作 `bonus_included_in` 的 target，`content_unit` 不能作 target——
  分盘/分轨署名、"某话改编自原作第 N 话"这类事实若目标实例定义仍无对应关系，按实现缺口上报。
- **模型缺口清单**见 [模型表达不了的事实与上报路径](../metafusion-curator/reference-model-gaps.md)：遇到没有落点的
  真实事实（如漫画类型码、黑胶面位、区码字幕、生卒日期、角色关系），不要用近似数据填充，按"实现缺口"报告。

## 参考

- [metafusion-curator](../metafusion-curator/SKILL.md)
- [API 行为参考](../metafusion-curator/reference-api-behavior.md)
- [接口归属与写入范围](../metafusion-curator/reference-endpoint-scope.md)
- [文件上传与绑定](../metafusion-curator/reference-file-upload.md)
- [字段级来源、当前版本与封面权利策略](../metafusion-curator/reference-source-policy.md)
- [实体与层级数据模型](../metafusion-curator/reference-data-model.md)
- [类型码、字段白名单与结构化字段](../metafusion-curator/reference-types-and-fields.md)
- [关系码、方向与属性](../metafusion-curator/reference-relations.md)
- [模型缺口与上报路径](../metafusion-curator/reference-model-gaps.md)
- [质量检查清单](../metafusion-curator/reference-qa-checklist.md)
