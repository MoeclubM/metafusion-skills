---
name: lrm-catalog-standards
description: 按 MetaFusion 的 LRM 分层和真实发行证据命名 Agent、Collection、Work、ContentUnit、Expression、Release、Medium 与 Track。用于新建、补录、迁移、查重和审核跨媒介作品及发行版。
---

# MetaFusion LRM 与发行版规范

本技能专注于创作身份、命名和跨发行内容复用。实际 API 读写与来源资格使用 [metafusion-curator](../metafusion-curator/SKILL.md)；两个技能须放在同级目录。

先读 [实体与层级数据模型](../metafusion-curator/reference-data-model.md)判断事实落点；字段与关系是否可写，以目标实例当前生效 definitions 为准。本入口不另维护实体表、字段白名单或关系码数量。

## 命名与版本决策

1. Work 保存创作身份和正式题名；根据官方证据区分独立创作与发行修饰。不得机械删除正式标题中的 Season、Vol、OST 或其它词。出版社、品番、画质、音质、包装和普通/限定版信息放到对应发行或载体字段。
2. ContentUnit 保存同一 Work 内的逻辑章、集、篇目；Expression 保存可复用的正文、译文、录音或正片版本。盘号、黑胶面位和商品品番不能改变创作归属。
3. Release 对应一个可核实的发行版本。普通、限定、地区、数字和再版依真实差异分别编目；官方版名进入 title，日期、编号、地区和包装进入实例声明的字段。店铺赠品先判断是否改变商品版次，不能只因购买渠道不同就制造发行。
4. Medium 与 Track 按真实包装和目录建立；number 保留官方编号，position 表示顺序。复用同一 Expression，让 CD、黑胶、数字或不同专辑的 Track 通过 contents 引用它。
5. 歌曲自身可以是独立 Work；“单曲发行”是 Release，“专辑作品”可有自己的 Work。独立歌曲不因收录而改挂专辑；专辑到歌曲使用目标实例允许的组成关系，发行 subjects 声明全部实际收录的 Work。
6. 多作品盒装用 subjects + 实际 Medium/Track 收录链；只有来源证明汇编本身有创作身份时另建汇编 Work。附赠 MV/现场 BD 应建立实际载体及所收录表达，附件清单不能代替内容链。
7. 改编、续作和版本派生使用语义准确的当前启用关系；不同创作、译本、重录与混音先核内容身份，再决定复用、另建表达或另建 Work。不能仅凭同名、时长近似或来源站相同合并。

核心身份与发行事实采用 [字段级来源策略](../metafusion-curator/reference-source-policy.md)。无章节、曲目或真实发行证据时留空，不按卷数、盘数或平台格式推造层级。

## 需要细节时

- [实体与层级数据模型](../metafusion-curator/reference-data-model.md)：动画、音乐、图书范式与跨 Work 收录不变量。
- [字段适用层级与结构化字段](../metafusion-curator/reference-types-and-fields.md)：applicable_kinds、locator、附件、事件和外部 ID。
- [关系码、方向与属性](../metafusion-curator/reference-relations.md)：组成、署名、再版和特典关系的种子对照；实际以实例为准。
- [模型缺口与扩展通道](../metafusion-curator/reference-model-gaps.md)：不存在的语义落点及已授权的后台定义扩展。
- [质量检查清单](../metafusion-curator/reference-qa-checklist.md)：本次实际操作后的复核。
