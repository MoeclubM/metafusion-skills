# MetaFusion API 行为参考

本页只记目标实例行为与跨任务不变量。命令参数由工具 `--help` 提供，服务端请求载荷见[载荷模板](reference-api-templates.md)。实例响应与文档冲突时以实例为准；影响写入契约的差异先停止相关写入并记录。

## 实例发现与动态定义

- 元数据 API 统一位于 `/api`。开始实例操作时读取 `/api/openapi.json`、`/api/catalog/definitions`，再检查目标实体、权限和可见性；不要由旧快照或示例推断当前能力。
- 字段、词表、关系、模板和 locator 以 `definitions.document` 为准，只使用当前启用项；`names` 是显示文本，不是能力声明。definitions 只提供一份当前文档，无历史或回滚；没有结构引用字段的 kind，其 `structure.<kind>.fields` 可为 `null`。
- OpenAPI 是 handler 反射结果：schema 的 `required` 可能为空，`Idempotency-Key` 也可能只写在 operation summary 而未声明为 parameter。不要仅据这些形状推断字段或请求头必填/可选；核目标实例和实际处理器。
- 实体结构仍遵循八种固定 kind。`Release.subjects` 声明发行包含的 Work，`Track.contents` 结构性地引用 Expression；它们不是关系，跨实体维护不具原子性。`track_work` 若在当前 `release_role` 中启用，只能作为 subject role 使用，不是关系码。

## 读取与证据

- `404` 只表示当前调用者看不到对象或对象不存在，不能证明全库缺失。`401`、`403`、`429`、5xx、超时、网络失败和无法解析的响应都属于未知；停止依赖该读取结果的写入。
- 实体 List 始终排除 `status=deleted` 和 `status=merged` 的记录；核对历史重复时按旧 ID 调 GET/resolve，不能把列表未返回判作对象不存在。
- 分页结果只有在所有页成功遍历后才可用于完整性结论；部分范围、失败页或可见性限制须标为 partial。
- 当前修订只按 `revision.version == entity.version` 选择，不能默认列表首项最新。实体来源位于修订记录，属于修订级证据而非字段级 provenance；载荷被服务端接受不证明来源权威，按[来源策略](reference-source-policy.md)逐字段核验。
- 修订行只有写后 `snapshot`，没有 `before` / `after`；Track 历史投影也可能按可见性裁剪，不是完整备份，不能用来恢复不可见收录。

## 并发查重

- `mf-find-identity` 与 `mf-platform entity.create` 使用只读 `POST /api/catalog/entities/candidates`，在同一 PostgreSQL 快照中查题名/别名、外部 ID、标量属性并解析 canonical；无关实体新增或更新不要求重新扫描全库。
- `coverage.total` 统计匹配的原始候选，非整个 kind 的行数。`--limit` 是候选上限（默认/最大 1000），超过上限为 partial，收窄条件；不要反复扫描、睡眠等待低峰或移除属性绕过候选核验。
- 实例缺少候选端点、查询失败、候选截断或 canonical 未解析时停止依赖写入，不回退 offset 扫描，不把错误当零候选。快照不预留后续创建；不同 Agent 应避免重复分派同一身份，未知写结果保持原创建键并先回读。

## 写入边界

- 严格 DTO 会拒绝未知字段。创建、实体更新和关系操作的请求形状只查[载荷模板](reference-api-templates.md)及实例 OpenAPI；动态字段或枚举不从模板抄作服务器能力。
- 实体 `PUT` 是整实体替换，必须带当前 `expected_version` 并保留所有未修改的可写字段。正式题名、季名按官方证据维护，不机械改写；版次品番、包装或规格不拼入 Work 题名。
- **禁止对任何 Track 执行整实体 PUT，包括只改标题。** Track 的 GET `contents` 可能按当前用户可见性裁剪，回写该投影会丢失被裁剪的收录。Track 内容只使用目标实例支持的专用 contents 操作；本地使用哪个受控工具由[工具入口](local/tools/README.md)与工具 `--help` 决定。
- Track 状态使用 `PATCH /api/catalog/tracks/{id}/status`，由服务端事务读取完整事实；先核 OpenAPI 支持，缺端点不回退 PUT。请求只含 `status/expected_version/edit_note/sources`；发布降级仍走 unpublish，载荷见[模板](reference-api-templates.md#track)。
- 单条 Track contents 的 `inclusion.sources` 省略时，若 `expression_id`、`locator`、`attributes` 与旧项一致则保留旧来源；新增或这些事实有变化则继承本次编辑的顶层 `sources`。显式提供项级 `sources` 时优先。
- 写请求不得自动重试。收到 `409 version_conflict` 或写入结果不明时，先回读实体和当前修订，核对是否已生效及并发改动，再决定是否基于新版本重做；不得盲目重放。
- 写后按任务核对实体版本与字段、当前修订、关系和 occurrences。`2xx`、工具成功标志或 `readbackOK` 不能代替内容复核；操作部分完成时报告 partial。

权限、实体可见性和跨服务边界见[接口归属与写入范围](reference-endpoint-scope.md)；实体层级见[数据模型](reference-data-model.md)。
