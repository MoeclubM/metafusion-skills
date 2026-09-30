# 种子定义缺口、固定结构边界与扩展路径（面向 Agent）

本文件区分本地种子未提供的字段/关系与固定结构限制。字段、词表、语义关系及其允许端点可按授权通过后台 GUI 扩展，不需要修改代码；固定 kind、归属外键、Release `subjects` 和 Track `contents` 仍受服务端与数据库约束。目标实例可能已有扩展，报告前先读取其当前生效定义。

**遇到缺口时的唯一正确处理**：不要用近似数据填充（那是把错误固化成"事实"，并污染后续查重与谱系），
在报告里写明"实体 + 想表达的事实 + 当前定义是否已有落点"；种子缺字段按"需扩展定义"处理，真正的固定结构或行为限制才归为"实现缺口"。
报告格式见 [metafusion-curator SKILL](../metafusion-curator/SKILL.md) 的"审查结论格式"。

## 种子现状与正确处理

| # | 事实 | 本地种子或固定结构现状 | 正确处理与扩展范围 |
| --- | --- | --- | --- |
| 1 | 希望对漫画、小说、音乐等作受控业务分类 | 当前八类 kind 是通用结构，不含业务 types；自由 tags 和展示模板不承担受控分类约束 | 不借近似标签替代事实；若任务确需受控分类，先核实例是否有适用字段，再按授权通过 GUI 扩展字段/词表 |
| 2 | 载体技术规格、黑胶 A/B 面及新增格式 | medium 种子提供 `catalog_number`/`format`/`role`/`tags`，format 词表目前有 10 项；未提供细分技术字段 | 按事实粒度在 GUI 新增适用于 medium/track 的字段与格式词项；盘号用 `medium.number`，黑胶轨号可用 `track.number="A1"`，需要面位筛选时另设明确字段，不塞包装附件 |
| 3 | 发行活动、厂牌系列、代理渠道、正式版名、收录范围、整碟时长 | 种子已有 release 的 `events`/`distribution_channel` 等；未给每项事实单独的字段 | 真实发行题名用 `title`，事件按既有组字段语义填写；其余缺项在 GUI 新增适用于 release/medium 的字段或语义关系，不借 `edition_batch` 表达渠道 |
| 4 | 专辑曲目与盒装各组成发行的用途区别 | 种子 `release_role` 只有 `primary`/`compilation`/`supplement`，未细分 constituent 等角色 | 曲目创作身份用歌曲 Work；专辑 Work 可经 `includes` 包含歌曲，发行 `subjects` 声明所有实际收录 Work，Track 引用歌曲 Expression。角色不足时扩展词表；盒装与原独立发行的联系可扩展 release→release 语义关系，不强标 compilation 或 pressing_of |
| 5 | 页码、盘号、数字曲号与格式特有定位 | 种子 locator 锚点为 `medium`/`track`，黑胶方案默认未启用；实体已有 `number` | 卷/盘号用 medium.number，数字轨与黑胶轨号用 track.number；定位相对于实际 medium/track。格式特有字段和方案可在 GUI 配置，不能把未启用方案当成平台不支持 |
| 6 | 分盘/分轨署名、篇目改编与更多主体/发行关系 | 种子语义关系对 medium/track/content_unit 的端点允许范围有限，并非平台禁止这些 kind 建关系 | 按准确语义在 GUI 新增关系码或调整 `source_kinds`/`target_kinds` 与允许字段，先检查影响；不为挂署名复制 Expression，也不借 pressing_of 表达打包关系 |
| 7 | 收录与发行对象的附加属性 | 种子 `inclusion_attributes` / `subject_attributes` 是空组，未经扩展写子键会 `unknown_field` | 在 GUI 为对应组新增字段，再按实际收录语境填写；不塞 locator 或 attachments。歌曲起源与发行中特定用途是不同事实，分别核查 |
| 8 | 人物生卒、团体成立/解散与角色设定 | agent 种子仅提供 tags，未提供主体自有日期/设定字段 | 在 GUI 新增或调整字段的 `applicable_kinds` 使其适用于 agent；主体日期不写成 member_of/credit_for 的关系有效期 |
| 9 | "初回特典""活动限定""Amazon 特典""初回盘" | tags 已覆盖八种 kind，但属于自由标签 | 正式事实优先用语义匹配的 edition_type/edition_batch/attachments/store_bonuses；需要受控检索时扩展字段/词表，不再按旧业务类型限制标签 |
| 10 | 篇目时长、章节首发日、场馆与公演场次 | content_unit 种子有 language/entry_role/air_date/tags，其余未提供 | 日期符合 air_date 语义时用现有字段；其余在 GUI 新增适用于 content_unit 的字段。作品/篇目自身事实不移到某发行 Track 或 Expression 版本名上 |
| 11 | 同一歌曲录音被多个专辑、影片或其他发行收录 | Expression 必须属于一个 Work，`content_unit_id` 是同 Work 内可选单值；Track 的 contents 支持跨 Work 引用 | 复用歌曲 Work 下同一 Expression，在各发行 Track 建收录并声明 subjects；专辑组成用 includes。真实的创作派生可扩展语义关系；固定归属不靠复制歌曲或把 Expression 挂到另一 Work 绕过 |
| 12 | 同一作品的 Web、文库等版本编排不同 | ContentUnit 描述创作目录，发行版的承载顺序由 Medium/Track/contents 表达 | 仅重排或版次定位变化时复用内容身份，用各版本 Track 顺序与收录映射；有真实章节拆合或内容修订时按证据区分 ContentUnit/Expression。不靠重复 position 代替版本编排 |
| 13 | 外部 ID 区分 work/release-group/recording 等资源类型 | 预设键与 category 不一定细分外部资源语义 | 先核具体资源类型及实例外部库注册表，按授权扩展准确键、URL 模式与 category；不把不适用层级的 ID 塞进 infobox |
| 14 | 实体删除与归属迁移 | 没有实体 DELETE；kind/work_id/release_id/medium_id 受 immutable_scope 限制，GUI 不能改这些结构契约 | 先核身份、引用和关系影响；按授权重建正确实体并选择适用的 lifecycle 操作。不同作用域不可强行合并，保留修订与已完成步骤 |
| 15 | 清理终态实体的关联边 | deleted/merged 源端不可编辑，DeleteRelation 因源端权限拒绝；仅目标端终态时，生命周期管理员可通过目标端检查 | 区分源端与目标端，按实际权限和响应处理；合并工具在生命周期转换前完成已授权的边整理，失败即停止，不能宣称所有关联边恒 403 |

## 服务端不拦、但会漂移数据质量的项

这些模型支持、服务端不拒绝，靠自检与约定兜住（`scripts/check_data.py` 把它们列入 P1）：

- `release` 可以零 `medium` 入库（`release_without_medium`）；
- `subjects` 可以为空（不是必填字段，"发行里像必须有 subjects"是误读）；
- 同一 `medium` 下多张 `track` 的 `position` 可以重复，服务端不拦；
- `contents[].position` 只在自己那个 Track 内唯一，跨 Track 的曲序由 `track.position` 表达。

## 上报与扩展通道

事实确实需要新字段/新关系码时，正确的路径是**改 definitions**（管理员权限），不是绕接口：

1. `GET /api/admin/catalog-definitions` 读取单份当前配置，保留 `etag` 与完整 `document`（权限 `catalog.definitions.manage`）；
2. 在 GUI 或本地编辑 `document`，向 `POST /api/admin/catalog-definitions/impact` 提交 `{document}`，检查现有数据与待保存定义的兼容性；此调用只读，不保存草稿；
3. 处理 `issues` 并核查其他返回诊断后，`PUT /api/admin/catalog-definitions` 提交完整 `{document, expected_etag, edit_note, sources}`，其中 `expected_etag` 是第一步读到的值；保存会再次检查影响，不兼容时拒绝；
4. 回读当前配置，核对新 `etag` 与所保存内容，再继续依赖该定义的数据写入。`409 version_conflict` 时重新读取并比较并发修改，禁止盲重试。

服务器只保留当前生效文档；`etag` 是覆盖保护标记，不是历史版本 ID。没有定义版本列表、服务端草稿、发布或回滚接口，审计只保留变更摘要。

定义里的名称（字段/词表/关系正反名/模板分区/场景/固定结构展示名，以及货架、外部库的 `names`）**必须四语齐备**
（`zh-CN`、`zh-TW`、`en-US`，加 `ja` 或 `ja-JP`），否则 `four_locale_names_required`。
注意 `names` 与实体的 `translations` 是两套形状，别混用。

**Agent 的默认动作不是去建字段**：先把缺口写进报告，由有权限的人决定是否扩展模型；没有授权时不要动定义。

## 已核实的调用边界

- Import 对所有来源校验 entity_type 为 work/artist/organization/character；Bangumi Preview 同样校验并按 URL/ID 路由。DLsite/DMM 商品 Preview 返回 work，请求 entity_type 不参与该分支判断。回读明确 source 与 entity_type，不能套用旧实例的 artist 静默回退结论；
- 读端点容忍坏令牌（当匿名 200），写端点同令牌 401 —— 诊断时不要据此认为"我的令牌还有效"。
  **PAT 是例外**：`mfp_` 前缀走内省，无效 / 吊销 / 过期在读端点也返回 `401 invalid_token`；
  账号服务不可达返回 `503 auth_unavailable`（见 [接口归属与写入范围](reference-endpoint-scope.md)）。
- 终态源端不可编辑；终态目标端的删除权限按上表第 15 项判断；
- `release.attributes.publisher` 等 **entity 型引用必须指向可见实体**：指向他人的 draft 会 `invalid_reference`，
  搜索和单实体读取也按调用者过滤，不能把“搜索能看到自己的草稿”理解为能引用他人的隐藏草稿；
- 列表有稳定排序，但 offset 分页期间若发生并发修改，边界仍可能移动；客户端按 id 去重，完整性结论应说明是否在稳定数据集上核验。

这些是当前调用边界；只有目标实例与已核实处理器矛盾或明确妨碍任务时，才按请求、身份、响应与部署版本报告差异。不绕接口改库，不用近似数据填。

## 写库前的自检脚本

主仓库的 `scripts/check_data.py`（只读）会按定义驱动做一次全量体检，**分级只由脚本决定**：

- **P0 / P1 = 拦门**：脚本报出的 P0/P1 视为发布前必须处理，脚本退出码 1 即表示存在 P0/P1；
- **P2 = 只报告**：计数但不拦门（名称四语一类问题在这里）；
- 检查项与判据写在脚本自己的 docstring 里，不在这里另抄一份。

```bash
BASE=https://<实例> TOKEN=<会话令牌或 PAT> python scripts/check_data.py   # 跑一次，看本次分级与明细
```

**这里刻意不抄码表**：码名与分级是脚本里的字面量，抄进正文就会在两仓之间静默漂移——脚本改了分级或码名，
技能照旧拦门，Agent 会误判。要当前生效的「分级 → 码」映射，直接问脚本源码：

```bash
git -C <主仓库> grep -o -E '\("P[012]", "[a-z_]+"' -- scripts/check_data.py | sort -u
```

报告里引用某个码时，以脚本当次实际输出的码与分级为准，不要凭记忆写。

发布前跑一次，能提前发现服务端不拦、但会让数据漂移的问题；脚本不可用时在报告里标注"未执行"。
