# MetaFusion 编目 SOP

本流程适用于人工或 Agent 编目。它假设目标实例已经授权当前写入；只读审查可以执行到任意一步后结束。

## 第一步：确认实例和工具

确认 API 基址、认证状态、用户 locale 和目标版本。读取 OpenAPI（如提供）、taxonomy、relation-types 与相关实体详情。优先使用服务器返回的代码、名称和允许端点类型，不在脚本里复制一套静态词表。

## 第二步：来源与查重

对每个事实记录来源：

- Work 身份：官方作品页、出版社、制作委员会、发行厂牌、国家图书馆或权威数据库；
- Release：官方发行页、目录、条码/ISBN、品番和包装照片；
- CanonicalEntry：官方章节/分集/曲目目录或可核验母版信息；
- 关系：双方实体的官方关系说明或可信数据库。

按原题名、原文题名、别名、条码、品番和外部 ID 查询。已有 Work 只补缺失层级；同名但不同创作母体需要证据支持后才分开。

## 第三步：先建模再写载荷

把输入拆成 Work、CanonicalEntry、Release、Medium、Track 和 TrackContent：

1. Work 只放纯题名、原始语言、基础简介、标签和创作主体。
2. CanonicalEntry 只放同一 Work 的表达、分集、章节或母版；有来源才创建篇目，不从卷数推造章节。
3. Release 只在有真实发行证据时创建，填 edition_name、edition_date、publisher_id、barcode、catalog_number、packaging、distribution_channel 和发行版翻译。
4. Medium 按实际包装建立，填 position、name、format、media_category、role。
5. Track 按实际位置建立，填 medium_id、position、title、duration_seconds、ISRC、locator 和必要的兼容 work_id。
6. 一个 Track 可通过 contents 收录多个 CanonicalEntry；每个项填 canonical_entry_id、position 和 locator。单内容旧字段与 contents 不能互相冲突。

当前数据库要求 Track 与 TrackContent 属于 Release.work_id 的同一 Work。多作品盒装不能通过伪造 work_id 或直接 SQL 绕过；没有 Compilation 模型时标记模型缺口。

## 第四步：题名、翻译和封面预检

- 清除 Work 题名中的季数、盘号、卷号、规格、画质、音质、包装和字幕组信息；只有确实是独立创作实体时才保留在新 Work。
- Work / Artist / Franchise 翻译用数组；Release、Medium、Track、CanonicalEntry 按当前实现契约使用 JSON 对象。每个翻译字段都使用合法 locale。
- 按实例规则设置 cover_aspect。当前服务端允许 1:1、2:3、3:4、4:3 和空值自动推断；前三种是常见编目建议，不要伪造接口拒绝行为。
- 外部封面 URL 需通过服务端安全校验；优先持久化到对象存储，并核对图片来自官方或授权来源。

## 第五步：选择写入路径

优先使用可单独核对和审计的粒度端点：

- Work：POST /catalog/works，更新用 PUT /catalog/works/:id；
- CanonicalEntry：POST /catalog/canonical-entries，更新用 PUT /catalog/canonical-entries/:id；
- Release：POST /catalog/releases，更新用 PUT /catalog/releases/:id；
- Medium：POST /catalog/mediums，更新用 PUT /catalog/mediums/:id；
- Track：POST /catalog/tracks，更新用 PUT /catalog/tracks/:id；
- 关系：先读取 /catalog/relation-types，再使用实例支持的关系端点。

每次提交准备具体 edit_note 和相关 HTTP(S) source_urls。CanonicalEntry、Release、Medium、Track 的成员路径会验证证据；Work 创建和通用关系路径在部分版本中未强制证据，因此代理仍应自行预检并在结果中报告服务器差异。POST /catalog/submit 只作为兼容导入路径，不能假定它接收审计字段或提供全量事务。

## 第六步：按依赖顺序提交

按 Work → CanonicalEntry → Release → Medium → Track → TrackContent 的依赖顺序提交。每个阶段都读取响应并保存 ID；失败时停止后续写入，不用默认值填补缺失来源。关系边在两端实体存在后提交，并使用 qualifier 区分同一对实体的不同语义。

## 第七步：写后验证与报告

重新读取目标 Work、内容目录、Release、Medium、Track、关系和 revisions。检查 Work 归属、父子边界、position、TrackContent、翻译回退、封面比例和审计记录。关系审查还要检查自环、端点类型、启用状态、反向重复和层级边长路径；服务端响应成功不等于所有图路径都已经证明无环。

报告使用以下四种结果：通过、需补证据、需修正、实现缺口。每项写明实体、字段、证据、影响和下一步。
