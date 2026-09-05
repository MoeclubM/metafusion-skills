# MetaFusion LRM 架构参考

本参考解释 MetaFusion 如何把作品内容与商业发行分开。字段和当前服务器边界以 [当前实现契约](reference-runtime-contract.md) 为准。

## 层级关系

    Work
    ├── CanonicalEntry（作品内容目录 / 表达）
    │   └── parent_id：同一 Work 的目录树
    └── Release（具体商业发行）
        └── Medium（盘、卷、文件集或其他容器）
            └── Track（容器内位置）
                └── TrackContent（收录一个或多个 CanonicalEntry）

Work 是创作母体；它的题名不携带季数、卷号、盘号、画质、音质或包装。CanonicalEntry 是同一 Work 下可复用的表达，例如歌曲母版、动画分集、电影剪辑、漫画话或书籍章节。Release 是带日期、发行者、条码、品番和包装信息的一个真实版本。Medium 和 Track 描述该版本中实际存在的容器和位置。

AssetFile 由资产注册与绑定层独立管理。它可以被多个目录实体或发行版本引用，文件哈希与处理状态不属于 Work 或 CanonicalEntry 的题名事实。

## 关系和外键

- CanonicalEntry 必须有一个 Work；同一 Work 内的 parent_id 由外键和树校验保护。
- Release 必须有一个 Work；Medium 只能属于一个 Release，Track 只能属于一个 Medium。
- Track 的 work_id 是兼容字段。服务端从 Medium → Release 推导所属 Work，并拒绝不一致的 work_id。
- TrackContent 的 canonical_entry_id 必须指向 Track 所属 Release 的同一 Work；它不是跨作品关联表。
- TrackContent.position 用于同一 Track 内的收录顺序，locator 适合记录页码、章节号、时间码等定位信息。

## 表达复用的边界

同一 Work 的 CanonicalEntry 可以被该 Work 的多个 Release 重复收录，从而支持“收录于哪些版本”的反查。改编、续作、原声带、收录关系和角色出场属于 EntityRelationship，而不是把不同 Work 的 CanonicalEntry 直接挂到一条 Track 上。

当前实现没有安全的跨 Work 物理收录模型：000006_carrier_content_integrity 同时校验 tracks.work_id、tracks.canonical_entry_id 和 track_contents.canonical_entry_id。多作品盒装若没有显式 Compilation 实体或专用端点，必须标记为模型缺口；不能把盒装 Release 归到一部作品后再把其他作品塞进 Track。

## 跨媒介示例

### 动画系列

1. 为系列建立一个 Work。
2. 为每个有来源的分集建立 CanonicalEntry，使用 position、number、entry_role 和 parent_id 表达目录顺序。
3. 为每个真实蓝光、DVD 或数字发行建立 Release；为每张盘建立 Medium，为每个收录位置建立 Track，再用 TrackContent 指向对应分集。
4. 不要因为某套发行包含 4 张盘，就创建 4 个“盘”作品或把盘号拼入 Work 题名。

### 音乐专辑

1. 歌曲创作母体和具体录音表达按 Work / CanonicalEntry 分开。
2. 每张实体或数字专辑是独立 Release，盘片是 Medium，曲目位置是 Track。
3. 同一录音在该 Work 的多个 Release 中出现时复用同一 CanonicalEntry；版本差异写在 Release / Medium / Track。

### 图书与漫画

1. 没有章节证据时只创建 Work，不从卷数推造 CanonicalEntry。
2. 有章节目录证据后，按章节或篇章建立 CanonicalEntry，并在同一 Work 内设置父子和顺序。
3. 每个真实单行本、精装本或电子版是独立 Release；同一章节被多个版本收录时使用 TrackContent 复用。

## 不变量审查

审查或迁移后，至少检查：

- Work / CanonicalEntry / Release 的所有 work_id 一致；
- parent_id 没有自环、跨容器或闭环；
- 同一 Medium 或 Track 的 position 没有冲突；
- Track 的旧 canonical_entry_id 与 contents 没有表达不同内容；
- 多作品盒装未被错误地挂到单一作品；
- 物理封面和文件资产没有被误当成创作内容。
