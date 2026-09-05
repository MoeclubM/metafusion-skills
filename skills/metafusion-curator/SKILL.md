---
name: metafusion-curator
description: 执行 MetaFusion 跨媒介实体编目、查重、发行载体维护、关系审查和数据质量复核。用于创建、编辑、导入、合并或审核 Work、CanonicalEntry、Release、Medium、Track、Artist、Franchise 及 EntityRelationship。
---

# MetaFusion 编目与审查技能

本技能把考据结论安全地落到 MetaFusion 的当前数据模型中。它支持读操作、审查和已获授权的写操作，不替用户扩大写入范围，也不为绕过服务端约束而直接修改数据库。

## 先确认运行时口径

1. 读取 [当前实现契约](reference-runtime-contract.md)。如果目标实例提供 /api/v1/openapi.json、/catalog/taxonomy 或 /catalog/relation-types，先以实例响应和实际 API 为准。
2. 如果同时修改 MetaFusion 主仓库，核对已执行迁移、路由和处理器。示例中的字段名、枚举和事务语义都不能代替运行时验证。
3. 发现技能文档、OpenAPI、处理器或数据库迁移不一致时，暂停有风险的写入，记录差异和目标版本；不要猜测字段，也不要用 SQL 绕过约束。

## 标准工作流

### 1. 考据与查重

- 先收集与字段直接相关的权威来源：出版社或官方发行页、国家图书馆/ISBN、MusicBrainz、发行厂牌、制作委员会、Bangumi、TMDB 等。
- 使用搜索和实体详情按原题名、原文题名、别名、条码、品番和外部 ID 查重。
- 命中同一创作母体时复用 Work；缺少的是版本、容器、篇目或翻译就补相应层级。只有证据显示为不同创作实体时才新建 Work。
- 记录每个结论对应的来源。来源 URL 可访问只是最低条件，不能代替对内容的核对。

### 2. 选择正确层级

| 层级 | 应保存的事实 | 不应保存的事实 |
| --- | --- | --- |
| Work | 纯净创作母体、基础题名、创作主体、原始语言、作品级简介和标签 | 季数、碟号、卷号、分辨率、音质、出版社或包装 |
| CanonicalEntry | 一个 Work 下可复用的表达、母版、分集、章节或目录项 | 专辑名、发行品番和具体盘号 |
| Release | 一个 Work 的真实商业发行、edition_name、edition_date、publisher_id、barcode、catalog_number、packaging、封面和发行说明 | 将另一作品的盒装品番伪装成当前 Work 的单体发行 |
| Medium | Release 内真实的盘、卷、文件集或其他容器，及其顺序、格式、角色 | 作品目录树或没有来源的虚构盘片 |
| Track | Medium 内的物理位置项、标题、时长、ISRC、定位信息 | 把 Track 当作独立作品或用它迁移 CanonicalEntry |
| TrackContent | Track 收录的一个或多个 CanonicalEntry、收录顺序和 locator | 跨 Work 的隐式引用 |
| AssetFile | 资产注册层的文件、哈希、处理状态和绑定 | 下载地址、压制组名或文件名污染 Work 标题 |

CanonicalEntry 的 parent_id 只能指向同一 Work 的目录项；Medium 和 Track 的 parent_id 分别只能指向同一 Release 或 Medium。Track 的 work_id 可以省略，让服务端从 Medium 所属 Release 推导，但不能提交一个不同的 Work。

### 3. 清洗题名与分离规格

Work 题名只保留能辨识创作母体的主名。将 TV、OVA、剧场版、Season、Vol、S1、4K、1080p、FLAC、OST、初回限定、BOX 等修饰信息移到有证据的 Release、Medium、Track 或标签/关系中。遇到“卷”或“季”本身是独立创作实体的来源，先判断实体边界，再决定是否新建 Work；不要机械套黑名单。

Release 命名要能区分真实版本，优先使用来源中的官方版名，并把条码、品番、包装、日期和发行者放入独立字段。不要为了填满层级而捏造“网络连载版”“TV Broadcast”或空壳发行版。

### 4. 维护内容目录与发行载体

- 先创建或复用 Work，再创建属于它的 CanonicalEntry 目录；章节、分集和附录用 entry_role、position、number、version_label 表达。
- 有真实发行证据时创建 Release，再按实际包装建立 Medium 和 Track。Track 的单内容旧字段 canonical_entry_id 与多内容 contents 可以并存，但同一 Track 不要制造相互矛盾的两套引用。
- TrackContent.position 是收录项顺序，locator 保存页码、章节、时间段等定位；没有可复用内容的真实附录可以保留空内容 Track。
- 当前 000006_carrier_content_integrity 拒绝跨 Work 的 Track 和 TrackContent。多作品盒装不能挂到其中一部作品下，也不能借助直接 SQL 绕过检查。若实例没有明确的 Compilation / 汇编模型，把它记录为模型缺口，保留已核实的独立发行资料，并在报告中说明未完成物理映射。

### 5. 写入、审计与权限边界

- 写入前验证当前用户确有目标 API 的权限；读操作和审查不需要把结果写回系统。
- 每次编目变更都准备具体的 edit_note 和至少一个相关的 HTTP(S) source_urls，即使某个旧处理器没有强制它们。不要用 update、import 等空泛文字代替动机。
- CanonicalEntry、Release、Medium、Track 的成员端点会校验证据；Work 创建和关系写入的当前处理器可能没有同等校验，不能因此宣称审计已完整。POST /catalog/submit 是兼容路径，不能假设它接收审计字段或提供全量 ACID 事务；需要可追溯性时优先使用粒度端点。
- 关系写入只使用 /catalog/relation-types 返回的启用关系和允许端点类型。不要把来源名称直接写成 Artist ID，也不要为同一个角色拆出重复实体。

### 6. 写后验证

重新读取目标实体、父子树、发行列表、关系和 revisions，确认：

- Work 归属、纯题名和查重结果正确；
- parent_id、position、Work 一致性和 TrackContent 引用没有越界；
- 翻译能按请求语言 → en-US → original_language → 基础字段回退；
- 封面 URL、自然比例和来源符合实例规则；
- 服务器实际返回的 revision / audit 记录与报告一致。

关系审查要检查自环、启用状态、端点类型、重复反向边和层级边的长路径。请求成功不等于全库 DAG 已证明；如果目标版本存在遍历截断或并发校验限制，应把它作为实现风险报告，而不是默认为安全。

## 多语言与封面约束

- Work、Artist、Franchise 的 translations 使用数组；Release、Medium、Track、CanonicalEntry 使用当前契约规定的 JSON 形状。不要将一种形状复制到另一层。
- 关系类型、角色、介质格式、包装和标签的显示名来自 taxonomy / relation-types 与其多语言字段，前端不新增硬编码术语。
- cover_aspect 是显示比例字段。当前服务端支持 1:1、2:3、3:4、4:3 和空值自动推断；音乐、影视、书籍的前三种比例是编目建议，不能把建议误写成服务器拒绝规则。封面仍应来自可核实的官方或授权来源并避免拉伸、占位和水印。

## 审查结论格式

报告按“通过 / 需补证据 / 需修正 / 实现缺口”分类。每项给出实体、字段、来源、影响和建议动作；把已验证事实与推测分开。发现架构无法表达目标事实时，不用近似数据填充，直接指出需要的模型或 API 变更。

## 进一步参考

- [当前实现契约](reference-runtime-contract.md)：当前迁移、实体边界、翻译形状和端点差异。
- [编目 SOP](reference-sop-workflows.md)：从考据到写后核对的操作顺序。
- [质量检查清单](reference-qa-checklist.md)：题名、层级、关系、封面和审计检查。
- [API 载荷模板](reference-api-templates.md)：粒度端点字段与兼容路径的使用边界。
- [LRM 架构参考](reference-lrm-architecture.md)：跨媒介层级和表达复用原则。
