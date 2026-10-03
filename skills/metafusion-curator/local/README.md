# 本地运行时

[工具入口](tools/README.md)。所有 MetaFusion HTTP 经 `metafusion-api.mjs`。

## 凭据

本目录 `credentials.json` 已忽略：`{"baseUrl":"https://example.com","pat":"<本机填写>"}`。
`MF_BASE/MF_PAT` 可临时覆盖；`MF_CREDENTIALS` 可指定另一文件。真实凭据不进入日志或版本库。

## 低层客户端

`putEntity` 是整实体替换，不是 patch；**Track 禁用**，其 GET contents 可能被可见性裁剪。其他写入契约见 [API 行为](../reference-api-behavior.md)，载荷见 [模板](../reference-api-templates.md)。
