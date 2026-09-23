---
name: metafusion-curator
description: 执行 MetaFusion 跨媒介实体编目、查重、发行载体维护、关系审查和数据质量复核。用于创建、编辑、导入、合并或审核 Agent、Collection、Work、ContentUnit、Expression、Release、Medium、Track 及实体关系。
---

# MetaFusion 编目与审查技能

本技能把考据结论安全地落到 MetaFusion 的当前数据模型中。它支持读操作、审查和已获授权的写操作，
不替用户扩大写入范围，也不为绕过服务端约束而直接修改数据库。

## 先确认运行时口径

1. 目标实例统一使用 `/api`；版本或端点不明时不要尝试写入。
2. 先读 [API 行为参考](reference-api-behavior.md) 与 [API 错误码与修复动作](reference-api-errors.md)，再核对实例的 `GET /api/openapi.json`、`GET /api/catalog/definitions` 和当前用户角色。示例字段不能代替运行时验证。
3. 按使用目标做契约核验：
   - **线上实例**：直接检查用户提供或已确认的实例 URL 的 OpenAPI 与 definitions；写入前确认该实例、身份与权限。
   - **本机源码服务**：先检查 `scripts/verify_api_contract.py` 是否存在，读取其 `--help` 并使用明确的本地 base URL。不要凭记忆执行，也不要把源码/仓库内容扫描当作运行时核验。
4. 技能资料与目标实例不一致时，记录实际 URL、核验时间和差异；暂停有风险的写入。被拒后按错误码修正，不猜字段或绕过接口改库。

## 写入范围（只写目录）

编目写入只发生在**元数据目录**（`/api/catalog/*`、`/api/importer/*`）。其余前缀属于别的系统：

- **账号 auth**（`/api/setup`、`/api/auth/*`、`/api/admin/users*`、`/api/oauth/*`、`/api/oidc/jwks`）：
  登录、会话、令牌与账号管理（个人访问令牌 PAT 也在这一侧创建与内省）。业务权限（谁能编辑哪个实体）仍由目录判断。
  长期跑脚本或 Agent 时用 PAT（`mfp_` 前缀）而不是借用会话令牌，口径见 [接口归属与写入范围](reference-endpoint-scope.md)。
  注意 `/api/admin/*` **不是整段归账号**：`/api/admin/catalog-definitions`、`/api/admin/shelves`、
  `/api/admin/external-databases` 由目录服务提供（定义、货架、外部库管理）。
- **互动 community**（`/api/community/*`、`/api/favorites/*`、`/api/users/{id}/favorites`、`/api/users/{id}/stats`、`/api/messages/*`）：
  论坛、条目短评、收藏与私信。它们**不是**元数据事实，
  不要通过目录接口写入，也不要为它们建实体。
- **目录的其它只读入口**：`GET /api/exchange/entities/{id}`（导出快照）、
  `POST /api/exchange/proposals`（外部提案，落 `pending_review`，不直接写实体）、
  `GET /api/catalog/me/home-preferences`。它们不改变"编目写入只走目录"这条边界。
- **存储 storage**（`/api/storage/*`）：物理文件、sha256、直传、绑定与下载。
- **网关 gateway**：按前缀分流，前端调用点不因服务切换而改变。

硬性规则：判定"实体是否存在 / 是否可见"必须问目录：`GET /api/catalog/entities/{id}`
（非 200 一律按不存在处理），不要另建本地台账或缓存可见性结论。
详见 [接口归属与写入范围](reference-endpoint-scope.md)。

## 标准工作流

### 1. 考据与查重

- 先收集与字段直接相关的权威来源：出版社或官方发行页、国家图书馆/ISBN、MusicBrainz、发行厂牌、
  制作委员会、Bangumi、TMDB 等。
- 使用搜索和实体详情按原题名、原文题名、别名、条码、品番和外部 ID 查重
  （`GET /api/catalog/entities?q=…`）。
- 查重维度必须包含 **kind + 题名 + `types` + 父级作用域**：同名、同 kind 但类型码不同的实体是两回事
  （电影《君の名は。》与它的 OST 专辑就同名同 kind）。只按题名复用，会把篇目、表达和合集挂到错的母体上。
- 命中同一创作母体时复用 Work；缺少的是版本、容器、篇目或翻译就补相应层级。
  只有证据显示为不同创作实体时才新建 Work。
- 记录每个结论对应的来源。来源 URL 可访问只是最低条件，不能代替对内容的核对。

### 2. 选择正确层级

固定实体骨架是八类：`agent` / `collection` / `work` / `content_unit` / `expression` / `release` / `medium` / `track`。

| kind | 应保存的事实 | 不应保存的事实 |
| --- | --- | --- |
| agent | 责任主体：个人、团体、机构、虚构角色 | 按单部作品重复创建主体 |
| collection | 系列、企划、世界观等聚合枢纽 | 为作者个人作品全集硬建企划 |
| work | 纯净创作母体、基础题名、创作主体、原始语言、作品级简介和标签 | 季数、碟号、卷号、分辨率、音质、出版社或包装 |
| content_unit | 同一 Work 内的逻辑章、集、篇目**目录** | 专辑名、发行品番和具体盘号 |
| expression | 可被多个发行复用的表达：母版、正片、录音、译本 | 把某个发行专属的版次信息写在表达上 |
| release | 一个真实发行的版本信息（品番、条码、日期、包装）与 `subjects` | 挂到某一部作品的 `work_id` 下 |
| medium | 发行内真实的盘、卷、文件集及其顺序与载体规格 | 作品目录树或没有来源的虚构盘片 |
| track | Medium 内的物理位置项，及其 `contents` 收录的 Expression 与 locator | 把 Track 当作独立作品或当作目录层 |

归属规则：`content_unit` / `expression` 必须有 `work_id`；`medium` 必须有 `release_id`；
`track` 必须有 `medium_id`。`content_unit` 的 `parent_id` 只能指向同一 Work 的目录项，
`medium` / `track` 的 `parent_id` 只能指向同一 Release / Medium；`expression` **没有 `parent_id`**。
**`release` 没有 `work_id`**：被其载体实际收录表达的 Work 全部经 `subjects` 声明。

**每个实体都要声明 `types`**：`attributes` 的可写字段 = 该实体 `types` 的字段并集，未声明类型时
`attributes` 只能为空，写任何键都是 `unknown_field`；类型码的 `kinds` 不含本 kind 则 `invalid_type`。
类型码清单、逐 kind 可写字段与结构化字段形状见 [类型码、字段白名单与结构化字段](reference-types-and-fields.md)。

### 3. 清洗题名与分离规格

Work 题名只保留能辨识创作母体的主名。将 TV、OVA、剧场版、Season、Vol、S1、4K、1080p、FLAC、
OST、初回限定、BOX 等修饰信息移到有证据的 Release、Medium、Track 或标签/关系中。
遇到"卷"或"季"本身是独立创作实体的来源，先判断实体边界，再决定是否新建 Work；不要机械套黑名单。

Release 命名要能区分真实版本，优先使用来源中的官方版名，并把条码、品番、包装、日期和发行者放入对应字段。
不要为了填满层级而捏造"网络连载版""TV Broadcast"或空壳发行版。

### 4. 维护内容目录与发行载体

- 先创建或复用 Work，再创建属于它的 `content_unit` 目录；章节、分集和附录用 `parent_id`、`position`、`number` 表达。
  `number` 保留官方原文（`A1`、`EX` 这类不要改写成整数），`position` 只表示排序。
- 需要跨发行复用时补 `expression`；它是"收录到 Track 上的那一层"。
- 有真实发行证据时创建 Release，在 `subjects` 中声明该发行收录的**全部** Work 及 `role`
  （`primary` / `compilation` / `supplement`），再按实际包装建立 Medium 和 Track。
- `track.contents` 是唯一收录来源，项为 `{expression_id, position, locator}`；
  `locator` 保存页码、章节、时间段或路径。整轨收录允许 locator 为空；
  有其它定位子字段时必须给 `relative_to` 锚点。
- **多作品盒装是受支持能力**：在 `subjects` 声明载体实际收录的各个 Work；只有来源证明汇编本身是独立创作母体时才另建汇编 Work。
  不要把盒装品番挂到其中一部作品，也不要用伪造 `work_id`、直接 SQL 或改触发器绕过
  `undeclared_release_subject` 校验。

### 5. 写入、审计与权限边界

- 写入前验证当前用户确有目标 API 的权限；读操作和审查不需要把结果写回系统。
- 创建用 `POST /api/catalog/entities`（`expected_version` 为 0、`entity.id` 留空），
  更新用 `PUT /api/catalog/entities/{id}`。**PUT 是整实体替换**：先 GET 完整实体，只改需要改的字段，
  其余字段原样带回。
- **发布靠 PUT 写 `status: "published"`**（要求至少一条翻译，否则 `translation_required`）。
  `POST /api/catalog/entities/{id}/lifecycle`（管理员）**只做合并与停用**，body 是
  `{target_id?, expected_version, edit_note, sources}`：`target_id` 留空即停用、有值即合并
  （目标须同 kind、同归属且已发布，否则 `invalid_merge_target`），**没有 `action` 字段**——
  带 `{"action":"publish"}` 会 `400 invalid_payload`。
- **退回走下架端点**：`POST /api/catalog/entities/{id}/unpublish`（权限 `catalog.lifecycle.manage`，与合并/停用同一档），
  body 是 `{expected_version, edit_note, sources}`——**没有 `target_id`**（带上会 `400 invalid_payload`）。
  它是状态机里**唯一**的降级通道，只接受 `published`：已发布条目退回 `draft`（回到草稿可继续编辑，修订历史留痕，
  同事务写一条 `entity.unpublished` 事件）；`draft` / `pending_review` 没有可下架的内容，`deleted` / `merged` 是终态，
  四种状态一律 `400 invalid_status`。版本不符 `409 version_conflict`，缺证据 `evidence_required`。
  普通 PUT 提交降级仍返回 `use_lifecycle_endpoint`；退回须使用下架端点。
- 每次编目变更都准备具体的 `edit_note` 和至少一个 `sources` 项
  （`kind` 为 `url` / `publication` / `self`，`citation` 必填，带 `url` 时必须是合法 HTTP(S)）。
  **服务端强制校验**：实体与关系写入缺证据一律返回 `evidence_required`，没有例外可赌。
  证据字段只认 `sources` 对象数组（`source_urls` 字符串数组会被严格解析拒收）。
- 创建实体与创建关系支持 `Idempotency-Key` 头。幂等键 = 路由 + 用户 + 键值，**不做载荷哈希**：
  同键第二次调用被当成重放，直接返回**首条**结果（即使换了载荷也一样）。所以键必须唯一标识"这一次创建"
  （含两端、父级作用域、版次等区分维度），重试要复用同一载荷。更新与删除靠 `expected_version`，
  409 `version_conflict` 时回读再重放。
- 关系写入只使用 `GET /api/catalog/definitions` 中 `enabled` 的关系码与允许的两端 kind / 业务类型，
  经由 `POST /api/catalog/relations`、`PUT` / `DELETE /api/catalog/relations/{id}`。
  **删除关系必须在 body 里带 `expected_version`**，与 `edit_note` / `sources` 同体，否则 409 / 400。
  关系码的方向、属性字段与端点限制见 [关系码、方向与属性](reference-relations.md) 的种子快照，实际以目标实例已发布定义为准；
  不要把来源名称直接写成 agent ID，也不要为同一个角色拆出重复实体。

### 6. 写后验证

重新读取目标实体、`relations`、`occurrences`、`revisions`（必要时用 `/api/catalog/compare?ids=…`），确认：

- Work 归属、纯题名和查重结果正确；
- `work_id` / `release_id` / `medium_id`、`parent_id`、`position` 与 `contents` 引用没有越界；
- 每个发行的 `subjects` 覆盖了实际收录表达的全部 Work；
- 翻译能按请求语言 → en-US → original_language → 基础字段回退；
- 封面 URL、图片比例和来源符合实例规则；
- 服务器实际返回的 revision / 审计记录与报告一致，未请求修改的数据没有丢失。

关系审查要检查自环、启用状态、端点类型、反向边语义和层级边的长路径。请求成功不等于全库 DAG 已证明；
请把结论限定在已复核的局部，并把并发限制或遍历截断作为实现风险报告，而不是默认为安全。

## 文件与存储

作品/发行的文件本体不属于元数据。文件走存储服务：`POST /api/storage/upload/initiate`（命中 sha256 即秒传）
→ 预签名分片直传或 `PUT /api/storage/upload/stream/{asset_id}` → `POST /api/storage/bind` 用 `binding_role`
表达用途。读取可见性是**上传者或任一绑定目标可见即可读**，下载、预览与哈希校验共用同一判定。
不要把哈希、对象键或下载地址写进实体字段。详见 [文件上传与绑定](reference-file-upload.md)。

## 多语言与封面约束

- 所有实体的 `translations` 都是**对象**：`{"zh-CN":{"title","summary","aliases"}}`；数组形状会被拒收。
- 关系类型、角色、载体格式、包装和标签的显示名来自 `GET /api/catalog/definitions` 与其词表，
  前端不新增硬编码术语。
- 定义、货架、外部库的 `names` 必须**四语齐备**（`zh-CN`、`zh-TW`、`en-US`，加 `ja` 或 `ja-JP`），
  否则 `four_locale_names_required`；它与实体的 `translations` 是两套形状。
- `attributes.tags` **只有 10 个 work 类型有**：release / medium / track / content_unit / expression /
  collection / agent 写 tags 一律 `unknown_field`，版本与包装信息请用各自字段承载。
- 封面走 `pictures: [{url, caption:{locale:说明}, source:{kind,citation,url?}}]`；
  `url` 必须是绝对 HTTP(S) 地址。不要在实体顶层写 `cover_aspect` / `cover_image_url`——它们不在写入 DTO 里，
  严格解析会直接 400。画幅比例若实例定义声明了对应字段，放在 `attributes` 下。
- 封面仍应来自可核实的官方或授权来源，保留自然比例，避免拉伸、占位和水印。

## 审查结论格式

报告按"通过 / 需补证据 / 需修正 / 实现缺口"分类。每项给出实体、字段、来源、影响和建议动作；
把已验证事实与推测分开。发现架构无法表达目标事实时，不用近似数据填充，直接指出需要的模型或 API 变更。

## 进一步参考

- [API 行为参考](reference-api-behavior.md)：统一 `/api` 前缀、八类实体边界、翻译形状、写入校验与端点差异。
- [API 错误码与修复动作](reference-api-errors.md)：常见拒绝码的含义与改法（证据 / 字段 / 词表 / 结构归属 / 关系 / 并发 / 权限）。
- [接口归属与写入范围](reference-endpoint-scope.md)：哪些前缀属于编目、哪些不属于，以及"实体是否存在/可见"该问谁。
- [文件上传与绑定](reference-file-upload.md)：内容寻址与秒传、预签名直传、`binding_role`、读取可见性口径。
- [质量检查清单](reference-qa-checklist.md)：题名、层级、关系、封面和审计检查。
- [API 载荷模板](reference-api-templates.md)：统一实体入口的字段与兼容路径的使用边界。
- [类型码、字段白名单与结构化字段](reference-types-and-fields.md)：`types` 如何决定可写属性、逐 kind 字段表、词表全量、locator/attachments/infobox 的形状。
- [关系码、方向与属性](reference-relations.md)：种子关系码的方向与端点、关系属性及多边与成环口径。
- [实体与层级数据模型](reference-data-model.md)：跨媒介层级和表达复用原则、常见建模范式。
- [模型缺口与上报路径](reference-model-gaps.md)：表达不了的事实清单、扩展 definitions 的正规通道。
