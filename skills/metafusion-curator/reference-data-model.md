# 实体与层级数据模型（面向 Agent）

站点把"创作内容"和"商业发行"分成两层来存。固定实体骨架是八类
（`agent` / `collection` / `work` / `content_unit` / `expression` / `release` / `medium` / `track`），
字段码与枚举以实例的 `GET /api/catalog/definitions` 为准（见 [API 行为参考](reference-api-behavior.md)）。

## 层级关系

    agent（责任主体）
    collection（系列 / 企划，经 includes 聚合作品）
    work（创作母体）
    ├── content_unit（同 Work 的逻辑章 / 集 / 篇目目录）
    │   └── parent_id：同一 Work 内的目录树
    └── expression（可复用的表达：母版、分集正文、录音、译本）
    release（具体发行；经 subjects 声明所收录表达的全部 Work）
    └── medium（盘、卷、文件集）
        └── track（容器内位置）
            └── contents[]（引用一个或多个 expression，带 position、locator 与 sources）

`Work` 保存创作身份与正式题名。发行侧的盘号、画质、音质和包装不能拼入题名；官方创作名中的季数、卷号或 OST 等词须按来源判断身份，不能机械删除。
`ContentUnit` 是同一 Work 内的逻辑目录（第几话、第几章、第几卷的篇目），
`Expression` 是**可被多个发行复用的那一层**（某个录音母版、某集正片、某段正文、某个译本）。
`Release` 是带日期、发行者、条码、品番和包装信息的一个真实版本；
`Medium` 和 `Track` 描述该版本中实际存在的容器和位置。

`agent` 是责任主体（个人 / 组织 / 团体 / 虚构角色）：没有独立的 `artist` 或 `franchise` 实体，
创作者与机构都落 `agent`，系列与世界观落 `collection`，署名与登场通过关系表达。

物理文件不属于元数据：文件、sha256、对象存储键与绑定由**存储服务**管理
（见 [文件上传与绑定](reference-file-upload.md)）。文件哈希与处理状态不进 Work 或 Expression 的题名事实；
"收录在第几轨、什么时间码"留在目录侧的 `locator`，文件的用途由存储侧的 `binding_role` 表达。

## 关系与归属

- `content_unit` 与 `expression` 必须有一个 `work_id`；`content_unit` 的 `parent_id` 只能指向同一 Work 的目录项。
- `expression` 可带 `content_unit_id`（必须同 Work），**不能带 `parent_id`**。
- `medium` 必须有一个 `release_id`，`parent_id` 只能指向同一 Release 的 Medium。
- `track` 必须有一个 `medium_id`，`parent_id` 只能指向同一 Medium。
- `track.contents[].expression_id` 指向表达；`position` 是同一 Track 内的收录顺序，
  `locator` 记录页码、章节号、时间段、文件路径等定位信息；新版 `sources` 保存直接收录证据，旧记录可为空，不自动补造。
- `release.subjects` 声明该发行实际收录表达的**全部** Work，`role` 用 `release_role`
  （`primary` / `compilation` / `supplement`）。任一收录表达的 Work 未在 `subjects` 里声明，
  保存会被拒绝（`undeclared_release_subject`）。
  `subjects` 本身**不是必填字段**：服务端允许零 `subjects`（甚至零 `medium`）的发行入库，
  但那样的发行表达不了收录事实，自检会记 P1，别把"服务端没拦"当成建模完成。
- `attributes` 的可写字段由当前 `document.fields` 的 `applicable_kinds` 决定；当前请求没有实体 `types`。详见 [字段适用层级与结构化字段](reference-types-and-fields.md)。
- 所属域不可变：普通 PUT 不能改 `kind` / `work_id` / `release_id` / `medium_id`；换归属等于重建实体。

## 表达复用的边界

以下能力需先确认目标实例的 OpenAPI 与 definitions 已支持，不能将源码新增能力当作已部署事实：

- 整本译文或整季剪辑可用 `usage=expression_composition` 的关系有序包含同 Work 的章节/分集表达（种子码 `expression_part`）。部分可被多个整体复用；同一整体在全部同用途码中不能重复部分或 position，并共同检查无环。仅返回直接组成，不自动递归展平或证明两份表达等同。
- 普通、限定、地区与黑胶 Release 可经 `usage=release_group` 关系归到同一个 Work 或 Collection（种子 `edition_of`）；每个发行在全部同用途码中最多一个组。专辑 Work 可作组，纯商品组织可用 Collection，无需新 kind。
- 共享 subjects 只表示共同收录作品；同一歌曲出现在单曲、专辑、精选集中，不意味着这些发行互为版本。升级不推测补边，按来源明确建立版本组。

同一 Expression 可以被多个发行、多个 Track 重复收录，从而支持"收录于哪些版本"的反查
（`GET /api/catalog/entities/{id}/occurrences`）。
改编、续作、原声带、角色登场属于**关系**（`adaptation_of` / `sequel_of` / `soundtrack_of` / `character_in` 等），
不是把别的 Work 的 Expression 塞进当前 Work 的目录。

跨作品收录是**一等能力**，不是缺口：多作品盒装的正确做法是

1. 只在来源证明汇编本身是独立创作母体时，为它另建 Work；
2. 给盒装发行写 `subjects`，覆盖各分碟实际收录表达所属的全部 Work；角色从目标实例 `release_role` 词表选择，若缺准确角色则报告模型缺口；
3. 各分碟的 Medium / Track 通过 `contents` 收录各作品自己的 Expression。

**反例**：把盒装品番挂在单部作品下，或伪造 `work_id`、直接改库绕过 `undeclared_release_subject`。

## 跨媒介示例

### 动画系列

1. 为系列建立一个 Work（系列世界观本身另建 `collection`，用 `includes` 关联）。
2. 为每个有来源的分集建立 `content_unit`（目录层），需要复用母版时再为分集建 `expression`。
3. 为每个真实蓝光、DVD 或数字发行建立 Release，并声明 `subjects`。
4. 为每张盘建立 Medium，为每个收录位置建立 Track，用 `contents` 指向对应 Expression。
5. 不要因为某套发行包含 4 张盘，就创建 4 个"盘"作品或把盘号拼入 Work 题名。

### 音乐专辑

> **跨专辑复用的范式**：专辑 = 一个有证据的 `work`；有独立作品身份的歌曲 = 各自的
> `work`，专辑到歌曲可用当前定义允许的 `includes` 关系；录音 = 歌曲 Work 下的
> `expression`；实体盘 = `release` + `medium` + `track`，由 `track.contents` 收录录音。
> 专辑自身的 `content_unit` 只表达确属该专辑内部的篇目目录，不能把已有独立歌曲 Work 的录音
> 改挂到专辑 Work 下。发行的 `subjects` 必须同时覆盖专辑和每首被收录歌曲的 Work；若实例词表没有
> 适合歌曲作为组成部分的 `release_role`，按实现缺口上报，不把 `compilation` 解释成精确语义。
> 电影《君の名は。》与它的 OST 专辑同名、同 kind（都是 `work`），**靠内容身份、责任主体、来源与收录关系区分**；标签只给线索，不能独自证明身份或成为合并理由。

1. 歌曲创作母体是 Work；具体录音/母带是 Expression（不同编曲版本是不同 Expression，或经 `alternate_take_of` 关联）。
2. 单曲和专辑各自有真实发行时分别建立 Release；一张专辑的普通版、限定版、地区版也各有 Release，按实物建立 CD、黑胶或特典 BD 的 Medium 与 Track。
3. 同一录音在单曲和多个专辑发行中出现时复用同一 Expression；版本差异写在 Release / Medium / Track。
4. 例如歌曲 A 的录音 A1 被单曲 CD 第 1 轨、专辑 B CD 第 3 轨、黑胶 A1 轨及精选 C 第 8 轨复用；各发行的 subjects 声明歌曲 A。专辑 B 的普通/限定/地区/黑胶发行显式归专辑 B 组，精选 C 归自己的组。限定版附赠 MV BD 建真实 Medium/Track，并声明 MV 表达所属 Work。

### 图书与漫画

1. 没有章节证据时只创建 Work，不从卷数推造 `content_unit`。
2. 有章节目录证据后，按章节或篇章建立 `content_unit`，并在同一 Work 内设置父子与顺序。
3. 每个真实单行本、精装本或电子版是独立 Release；同一章节被多个版本收录时复用同一 Expression，
   locator 记页码与章节（页码是"本版定位"，会随排版变化）。
4. 整本原文/译文各建整体 Expression，与对应章节 Expression 用表达组合关系连接；章节译文另用 translation_of 指向章节原文。出版物中的顺序以实际 Track 和 contents 为准。

## 不变量审查

审查或迁移后，至少检查：

- `content_unit` / `expression` 的 `work_id` 一致，`medium` / `track` 的 `release_id` / `medium_id` 正确；
- `parent_id` 没有自环、跨容器或闭环，且 `expression` 上没有误填 `parent_id`；
- 同一 `track.contents` 数组内的 `position` 不重复（`duplicate_position` 只管这一层）；
  同一 Medium 下兄弟 Track 的 `position` 服务端**不拦**（实测重复也能建），靠自检与约定约束；
- 每个发行的 `subjects` 覆盖了它实际收录表达的全部 Work（否则会出现 `undeclared_release_subject`）；
- 表达组合符合共同 Work、无环与跨同用途码的唯一顺序；版本组有明确来源，没有从 subjects 或格式推测；
- 多作品盒装没有被错误地挂到单一作品，也没有伪造 `work_id`；
- 封面与文件资产没有被当成创作内容，哈希/对象键/下载地址没有写进题名或动态字段。

## 批次容量与可计口径

规划实体数量时同时报告四个互不替代的指标：

- `N_total`：通过当前版本 P1、封面权利、实体边界与 canonical 去重的可计实体总数；
- `N_work`：其中独立创作母体数；
- `N_release_chain`：具有可核实发行链的 Work / Release / Medium / Track 组合数；
- `N_support`：为这些内容服务的 Agent、Collection、Expression、ContentUnit 等支持实体数。

`N_total` 不能用“现有八类比例 × 目标数”机械放大：Agent/Collection 或空壳层级增长不等于新增完整作品。批次目标应先确定 Work 与发行链容量，再根据真实引用补支持实体；所有计数都按 canonical id 去重，并逐实体输出 `count_eligible` 与缺口。来源、封面和当前版本门槛见[字段级来源策略](reference-source-policy.md)。
