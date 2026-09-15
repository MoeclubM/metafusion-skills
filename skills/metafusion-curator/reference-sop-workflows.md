# MetaFusion 编目 SOP

本流程适用于人工或 Agent 编目。它假设目标实例已经授权当前写入；只读审查可以执行到任意一步后结束。
所有写入都在 `/api/catalog/*`（**无版本前缀**）；涉及的系统归属见 [接口归属与写入范围](reference-endpoint-scope.md)。

## 第一步：确认实例和工具

确认 API 基址、认证状态、用户 locale。读取 `GET /api/openapi.json`、
`GET /api/catalog/definitions`（类型、字段、词表、关系、模板、场景）与目标实体详情。
优先使用服务器返回的代码与名称，不在脚本里复制一套静态词表。
确认用户角色：普通角色只能写 `draft` / `pending_review`，`editor` 可维护已发布条目，发布与合并归管理员。

## 第二步：来源与查重

对每个事实记录来源：

- Work 身份：官方作品页、出版社、制作委员会、发行厂牌、国家图书馆或权威数据库；
- Release：官方发行页、目录、条码/ISBN、品番和包装照片；
- ContentUnit / Expression：官方章节、分集或曲目目录，或可核验的母版信息；
- 关系：双方实体的官方关系说明或可信数据库。

按原题名、原文题名、别名、条码、品番和外部 ID 查询（`GET /api/catalog/entities?q=…`）。
已有 Work 只补缺失层级；同名但不同创作母体需要证据支持后才分开。

## 第三步：先建模再写载荷

把输入拆成 Work、ContentUnit、Expression、Release、Medium、Track：

1. **Work** 只放纯题名、原始语言、基础简介、标签与创作主体（署名走关系）。
2. **ContentUnit** 只放同一 Work 的表达/分集/章节**目录**；有来源才创建，不从卷数推造章节。
3. **Expression** 放可被复用的那一层（母版、正片、录音、译本）；可挂 `content_unit_id`，不能挂 `parent_id`。
4. **Release** 只在有真实发行证据时创建；写 `subjects` 声明收录的**全部** Work 与 `role`。
5. **Medium** 按实际包装建立，填 position、名称与载体规格字段。
6. **Track** 按实际位置建立，用 `contents` 的 `expression_id` / `position` / `locator` 表达收录。

多作品盒装**不再标为模型缺口**：按 [实体与层级数据模型](reference-data-model.md) 建汇编 Work + `subjects`，
不要伪造 `work_id` 或用直接 SQL 绕过 `undeclared_release_subject`。

## 第四步：题名、翻译和封面预检

- 清除 Work 题名中的季数、盘号、卷号、规格、画质、音质、包装和字幕组信息；只有确实是独立创作实体时才保留。
- 所有实体统一使用 `translations` **对象**（`{"zh-CN":{"title","summary","aliases"}}`），
  不存在"某些 kind 用数组"的分支；每个 locale 都要是合法语言标签。
- 封面走 `pictures`，`url` 必须是绝对 HTTP(S) 地址（相对路径会被判 `invalid_picture`），
  `source` 同样要满足证据规则。画幅比例若实例定义声明了字段码，放在 `attributes` 下；
  不要提交顶层 `cover_aspect`。
- 封面优先来自官方或授权来源，保留自然比例，不使用占位图或水印。

## 第五步：选择写入路径

| 操作 | 端点 |
| --- | --- |
| 创建实体（任意 kind） | `POST /api/catalog/entities` |
| 更新实体 | `PUT /api/catalog/entities/{id}`（整实体替换，先 GET 再改） |
| 发布 / 退回 / 合并 / 停用 | `POST /api/catalog/entities/{id}/lifecycle`（管理员） |
| 新建关系 | `POST /api/catalog/relations` |
| 更新 / 删除关系 | `PUT` / `DELETE /api/catalog/relations/{id}` |

每次提交都准备具体 `edit_note` 与至少一个 `sources` 项（`kind` 为 `url` / `publication` / `self`）。
**证据由服务端强制**：实体与关系写入都会返回 `evidence_required`，不存在"某些端点不校验"的例外。
创建实体与创建关系可以带 `Idempotency-Key` 头（24 小时）；更新与删除靠 `expected_version`，不要靠重试。
旧契约里的 `POST /catalog/submit` 与 `PUT /catalog/entity-relations` 都**不存在**。

## 第六步：按依赖顺序提交

按 `agent` / `work` → `content_unit` / `expression` → `release` → `medium` → `track` → 关系的依赖顺序提交。
每个阶段读取响应并保存 ID；失败时停止后续依赖写入，不用默认值填补缺失来源。
关系在两端实体存在后提交，并由 `attributes` 承载职位原文、角色、语言等结构化上下文。
收到 409 `version_conflict` 时回读实体、带上新 `expected_version` 重放，不要盲目重试。

## 第七步：写后验证与报告

重新读取实体、`relations`、`occurrences`、`revisions`，必要时用 `/api/catalog/compare?ids=…` 对比发行。
检查归属与父子边界、`position`、`subjects` 覆盖、`contents` 的 expression 引用、
翻译回退、`pictures` 与修订记录。关系审查还要检查自环、两端 kind 是否被允许、反向重复与层级边长路径；
服务端响应成功不等于所有图路径都已经证明无环，请把结论限定在已复核的局部。

报告使用四种结果：**通过、需补证据、需修正、实现缺口**。每项写明实体、字段、证据、影响和下一步。
