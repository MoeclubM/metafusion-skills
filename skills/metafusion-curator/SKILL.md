---
name: metafusion-curator
description: MetaFusion 实体编目、查重、关系维护与数据质检。用于目录数据读写，不用于代码开发或部署。
---

# MetaFusion 编目

## 入口

在 `local/tools/` 使用 `mf-source` 检索来源、`mf-platform` 读写目录、`mf-definitions` upsert 词项或受控新增单个字段。参数查工具帮助；[工具索引](local/tools/README.md)，[凭据配置](local/README.md)。

## 规则

- 开始实例操作时核 OpenAPI 与 definitions；字段、关系、词项使用当前启用定义。
- 查重核 kind、内容身份、父级作用域与 canonical ID；同名或同 Work 不证明同一 Expression。正式题名不机械清洗。
- Release `subjects` 声明 Work，Track `contents` 引用 Expression；先声明 subjects，再补收录。
- 写入需任务授权，先预览；保留未改字段，带当前版本，写后回读。Track 禁止整实体 PUT；冲突或结果不明不重放。

## 按需参考

| 任务 | 参考 |
| --- | --- |
| 层级、复用、命名 | [数据模型](reference-data-model.md)、[命名规范](../lrm-catalog-standards/SKILL.md) |
| 来源、当前证据、封面 | [来源策略](reference-source-policy.md) |
| 自定义请求或接口失败 | [载荷](reference-api-templates.md)、[API 行为](reference-api-behavior.md)、[错误码](reference-api-errors.md) |
| 权限与服务归属 | [接口范围](reference-endpoint-scope.md) |
| 字段、关系或定义缺口 | [字段](reference-types-and-fields.md)、[关系](reference-relations.md)、[扩展定义](reference-model-gaps.md) |
| 文件操作或质量审查 | [文件绑定](reference-file-upload.md)、[质检清单](reference-qa-checklist.md) |
