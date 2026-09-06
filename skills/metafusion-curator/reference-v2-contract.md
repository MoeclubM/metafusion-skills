# MetaFusion v2 编目契约

先读取实例 `/api/v2/openapi.json`、`/api/v2/catalog/definitions` 和 `/api/v2/auth/me`。v2 独立于旧 API，不把旧 ID 或 DTO 直接写入新目录；用户授权部署不等于自动导入旧目录。

## 实体与收录

- 固定种类为 agent、collection、work、content_unit、expression、release、medium、track。`types` 为动态代码列表，一个实体可组合多个类型；属性只使用这些类型引用的共享字段。
- Work 为创作身份；Collection 是聚合；ContentUnit 是同 Work 的逻辑章／集；Expression 必须有 work_id，content_unit_id 若存在必须同 Work。
- Release 没有独占 work_id。`subjects` 使用 `{work_id,role,position}`，覆盖所有被其载体实际收录表达的 Work。
- Medium 有 release_id，Track 有 medium_id；各自 parent_id 只能同域且无环。普通 PUT 不改变所属域。
- Track.contents 是唯一收录来源，项为 `{expression_id,position,locator}`。同一 Expression 可出现在单曲、专辑、精选集或不同介质发行。概念曲序用 `includes` 关系的 position。
- Locator 有 relative_to（track 或 medium），page_start/page_end、time_start_ms/time_end_ms、path、chapter。position 与印刷 number 分离，不将 A1、EX、78 改成排序整数。
- 作者个人作品可以没有 Release、文件、出版社和外部 ID。公开数字版也可为发行。翻唱通常是歌曲的 Expression；有独立创作身份的实质改编才另建 Work。
- 包装附件和店铺特典分别记在动态字段中；店铺赠品不能冒充盒内 Medium。编码、压制、WEB-DL 和 REMUX 属于可选资源模块。

## 编辑与来源

所有实体统一使用 translations 对象：`{"zh-CN":{"title":"题名","summary":"简介","aliases":[]}}`。展示回退为请求语言、en-US、original_language、基础 title；不要把展示值回写到基础题名。

创建 `POST /api/v2/catalog/entities`；编辑 `PUT /api/v2/catalog/entities/{id}`，请求为 `{entity,expected_version,edit_note,sources}`。创建 expected_version=0，更新带回读版本。PUT 是完整替换，保留未请求修改的字段。

sources 项为 `{kind,citation,url?}`，kind 支持 self、publication、url。url 来源必须有 HTTP(S) URL；作者自述可以无第三方来源，但必须如实标注。图片为 `pictures:[{url,caption:{语言:说明},source:{kind,citation,url?}}]`。每次变更都必须具体编辑说明和至少一个来源，不使用 v1 source_urls。

编辑者创建自己的 draft，提交 pending_review；管理员发布 published。公开元数据不能引用未公开实体。管理员合并使用 lifecycle 接口，目标同种类、所属相容且已发布，先确认身份；引用迁移和修订在一个事务内，关系基数或内容位置冲突会拒绝。停用不会清除外围文件。

关系写入是 `{relation:{type,source_id,target_id,position,attributes},expected_version,edit_note,sources}`。演员、角色、作品范围和语言保存在结构化上下文；不要从显示文案解析 ID，不要按两端 ID 直接去重多角色署名。

## 配置与验证

管理员定义先草稿、影响预览、发布。停用正在使用的类型／字段／词项时历史值仍可显示；不能在新数据里使用停用项。类型与字段名来自定义，不能靠修改代码“添加普通类型”。

写后 GET 实体、`relations`、`occurrences` 和 `revisions`。用 `/catalog/compare?ids=...` 检查发行差异。409 必须回读并处理冲突；响应不明先查状态，不盲目重试创建。

模块能力通过 `/api/v2/capabilities` 发现。归档、播放、社区、个人记录分开请求；导入提案走 `/exchange/proposals`（启用后），不会绕过核心校验。旧插件、AI、通知和第三方导入适配器不能假定已移植。
