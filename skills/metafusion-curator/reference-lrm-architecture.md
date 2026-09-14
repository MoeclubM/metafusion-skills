# MetaFusion LRM 架构参考

本参考解释 MetaFusion 如何把作品内容与商业发行分开。当前固定实体骨架是八类
（`agent` / `collection` / `work` / `content_unit` / `expression` / `release` / `medium` / `track`），
字段与服务器边界以 [当前实现契约](reference-runtime-contract.md) 为准。

## 层级关系

    agent（责任主体）
    collection（系列 / 企划，经 includes 聚合作品）
    work（创作母体）
    ├── content_unit（同 Work 的逻辑章 / 集 / 篇目目录）
    │   └── parent_id：同一 Work 内的目录树
    └── expression（可复用的表达：母版、分集正文、录音、译本）
        └── release（具体商业发行；经 subjects 声明所收录表达的全部 Work）
            └── medium（盘、卷、文件集）
                └── track（容器内位置）
                    └── contents[]（收录一个或多个 expression，带 position 与 locator）

`Work` 是创作母体；它的题名不携带季数、卷号、盘号、画质、音质或包装。
`ContentUnit` 是同一 Work 内的逻辑目录（第几话、第几章、第几卷的篇目），
`Expression` 是**可被多个发行复用的那一层**（某个录音母版、某集正片、某段正文、某个译本）。
`Release` 是带日期、发行者、条码、品番和包装信息的一个真实版本；
`Medium` 和 `Track` 描述该版本中实际存在的容器和位置。

`agent` 是责任主体（个人 / 组织 / 团体 / 虚构角色）：没有独立的 `artist` 或 `franchise` 实体，
创作者与机构都落 `agent`，系列与世界观落 `collection`，署名与登场通过关系表达。

物理文件不属于元数据：文件、sha256、对象存储键与绑定由**存储服务**管理
（见 [存储契约要点](reference-storage-contract.md)）。文件哈希与处理状态不进 Work 或 Expression 的题名事实；
"收录在第几轨、什么时间码"留在目录侧的 `locator`，文件的用途由存储侧的 `binding_role` 表达。

## 关系与归属

- `content_unit` 与 `expression` 必须有一个 `work_id`；`content_unit` 的 `parent_id` 只能指向同一 Work 的目录项。
- `expression` 可带 `content_unit_id`（必须同 Work），**不能带 `parent_id`**。
- `medium` 必须有一个 `release_id`，`parent_id` 只能指向同一 Release 的 Medium。
- `track` 必须有一个 `medium_id`，`parent_id` 只能指向同一 Medium。
- `track.contents[].expression_id` 指向表达；`position` 是同一 Track 内的收录顺序，
  `locator` 记录页码、章节号、时间段、文件路径等定位信息。
- `release.subjects` 声明该发行实际收录表达的**全部** Work，`role` 用 `release_role`
  （`primary` / `compilation` / `supplement`）。任一收录表达的 Work 未在 `subjects` 里声明，
  保存会被拒绝（`undeclared_release_subject`）。
- 所属域不可变：普通 PUT 不能改 `kind` / `work_id` / `release_id` / `medium_id`；换归属等于重建实体。

## 表达复用的边界

同一 Expression 可以被多个发行、多个 Track 重复收录，从而支持"收录于哪些版本"的反查
（`GET /api/catalog/entities/{id}/occurrences`）。
改编、续作、原声带、角色登场属于**关系**（`adaptation_of` / `sequel_of` / `soundtrack_of` / `character_in` 等），
不是把别的 Work 的 Expression 塞进当前 Work 的目录。

跨作品收录是**一等能力**，不是缺口：多作品盒装的正确做法是

1. 为汇编作品（如"某某监督作品集"）建一个 Work；
2. 给盒装发行写 `subjects`：汇编作品 `primary`，各被收录作品 `compilation`；
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

1. 歌曲创作母体是 Work；具体录音/母带是 Expression（不同编曲版本是不同 Expression，或经 `alternate_take_of` 关联）。
2. 每张实体或数字专辑是独立 Release，盘片是 Medium，曲目位置是 Track。
3. 同一录音在该 Work 的多个 Release 中出现时复用同一 Expression；版本差异写在 Release / Medium / Track。

### 图书与漫画

1. 没有章节证据时只创建 Work，不从卷数推造 `content_unit`。
2. 有章节目录证据后，按章节或篇章建立 `content_unit`，并在同一 Work 内设置父子与顺序。
3. 每个真实单行本、精装本或电子版是独立 Release；同一章节被多个版本收录时复用同一 Expression，
   locator 记页码与章节（页码是"本版定位"，会随排版变化）。

## 不变量审查

审查或迁移后，至少检查：

- `content_unit` / `expression` 的 `work_id` 一致，`medium` / `track` 的 `release_id` / `medium_id` 正确；
- `parent_id` 没有自环、跨容器或闭环，且 `expression` 上没有误填 `parent_id`；
- 同一 Medium 或 Track 的 `position` 没有冲突；
- 每个发行的 `subjects` 覆盖了它实际收录表达的全部 Work（否则会出现 `undeclared_release_subject`）；
- 多作品盒装没有被错误地挂到单一作品，也没有伪造 `work_id`；
- 封面与文件资产没有被当成创作内容，哈希/对象键/下载地址没有写进题名或动态字段。
