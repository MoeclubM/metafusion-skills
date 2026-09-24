# 文件上传与绑定（面向 Agent）

一句话分工：**目录回答"这个实体是什么、谁能看"，存储回答"这份文件的字节在哪、挂给谁、有什么用途"。**

- 文件本体、哈希、直传地址与下载都走 `/api/storage/*`；作品/专辑/曲目等事实走 `/api/catalog/*`。
- 两者不重复：**文件说"我是谁的什么用途"（`binding_role`），目录说"收录在第几轨、什么时间码"（Track `contents` 的 `locator`）**。
- 因此：**不要把哈希、对象键或下载地址写进实体字段或题名。**

## 端点（`/api/storage/*`）

| 方法 | 路径 | 鉴权 | 说明 |
| --- | --- | --- | --- |
| POST | `/api/storage/upload/initiate` | 登录 | 直传第一步：命中 sha256 即秒传；否则签发预签名地址（分片则返回 `upload_id` 与每片地址） |
| POST | `/api/storage/upload/complete` | 上传者/管理员 | 分片合并并落定大小；单次 PUT 场景只做存在性确认 |
| PUT | `/api/storage/upload/stream/{asset_id}` | 上传者/管理员 | 服务端流式接收（本地对象模式的主要上传方式，也可作为预签名不可用时的兜底），落盘前流式计算 sha256 与声明比对 |
| POST | `/api/storage/bind` | 上传者/管理员 | 绑定到目录实体，带 `binding_role` 用途 |
| DELETE | `/api/storage/bindings/{id}` | 绑定创建者/上传者/管理员 | 解绑纠错 |
| GET | `/api/storage/assets/{id}` | 可读 | 文件元数据 + 绑定列表 |
| GET | `/api/storage/entities/{id}/files` | 实体可见 | "这个介质/轨道/表达上挂了哪些文件"入口 |
| GET | `/api/storage/download/{asset_id}` | 可读 | 对象存储模式返回预签名下载地址；本地模式直接流式下发 |
| POST | `/api/storage/verify-hash` | 可读 | 只给 `sha256` = 秒传探测；给 `asset_id` = 读回对象重算摘要并与声明比对 |
| GET | `/api/storage/stats` | 管理员 | 完成态文件数与占用字节 |

## 内容寻址与秒传

- 资产身份是 **sha256**，不是文件名：`storage.assets` 对 `sha256` 建唯一索引（空值除外），
  对象键也由 sha256 派生，因此同一份内容只登记一条资产。
- `POST /upload/initiate` 带 `sha256_hash`（64 位小写十六进制）、`file_name` 与 `file_size`。
  **命中已有 sha256 即秒传**，响应 `is_instant_upload: true`，无需再传字节。
- 同一 sha256 的**未完成**上传由上传者本人续传，避免两个客户端互相覆盖；他人重复提交不会接管别人的上传会话。
- 秒传依赖客户端给出的 sha256 正确。服务端接收路径（`upload/stream`）边收边算并与声明比对；
  分片路径在 `upload/complete` 时回读对象真实大小再落定，不采信客户端库返回的长度。

## 预签名分片直传

- 大文件不要走服务端中转：`initiate` 传 `part_count` 即建立分片会话，返回 `upload_id` 与 `presigned_urls`
  （每片一个预签名 PUT 地址），客户端逐片直传后调 `upload/complete` 合并。
- 单次 PUT 场景（`part_count` 为空或 1）只返回一个预签名地址。
- 本地对象模式（未配置对象存储）没有预签名，改为返回 `direct_upload_url`
  （即 `PUT /api/storage/upload/stream/{asset_id}`），由服务端承接字节。
- 预签名地址用**客户端可达的对外地址**签发（SigV4 覆盖 Host）；反代或内网地址不一致时签名会校验失败，
  这是部署口径问题，不要试图通过改变编目字段绕过。

## binding_role 表达用途

- `binding_role` 用**字段码**表达用途，默认 `master_archive`，取值需匹配 `^[a-z][a-z0-9_]{0,31}$`（否则 `invalid_binding_role`）。
- **不设封闭枚举**：`track_audio`（分轨音频）、`disc_image`（整碟镜像）、`video`、`scans`（扫描件）、
  `subtitle`、`ebook` 等由运维与编目约定；新增用途不需要改代码。
- 绑定唯一键是 `(asset_id, target_entity_id, binding_role)`：同一文件可以挂给多个实体，
  同一文件对同一实体也允许不同用途各挂一条。
- `target_entity_type` 可以省略；给了必须与目录返回的权威 `kind` 相符，否则 `invalid_target_type`。
- 绑定前先判可见与权限：目标实体可见性由目录判定，不可见即 `404 not_found`；
  绑定人必须是该资产的上传者或管理员，否则 403。

## 读取可见性口径

- **唯一判定**：上传者本人或管理员直通；其余人只要**任一绑定目标实体可见**即可读。
- **下载、元数据读取与哈希校验共用这一判定**，因此不会出现"能下载不能预览"这类同一份文件在不同接口上口径不一致的差异。
- 未完成（`status != complete`）的资产对非上传者不可读。
- "实体可见"由目录服务判定（`GET /api/catalog/entities/{id}`），存储不缓存结论；
  调用者令牌原样转发，所以草稿/待审条目的可见性仍按请求者身份计算。

`GET /api/storage/entities/{id}/files` 的 `id` 是目录实体 ID；存储不保存目录结构。
目标实例若对某端点返回 404，核对其实际接口后再继续依赖该端点的写入。

## 封面是跨服务、跨证据链的受控流程

目录 `pictures` 与存储资产/绑定是两套状态，没有自动同步或跨服务事务；技术上传成功也不代表版权通过。封面只有在以下顺序全部核对后才可提交并计数：

1. 先按[字段级来源策略](reference-source-policy.md)确认图像身份、官方/权利方图源及覆盖本服务展示、复制或热链的许可/授权；缺项保持 `rights_review=blocked`。
2. 获权后才上传或直传，回读资产 `sha256`、MIME、`complete`、`hash_verified`、`blocked` 等状态；禁止缩略图放大、截图、拼贴、拉伸、占位或水印图。
3. 用 `binding_role=cover_image` 绑定目录实体，GET `/api/storage/entities/{id}/files` 核对 asset_id 与角色完全一致。
4. 再用完整实体 PUT 写 `pictures[]`，保留其它字段并带 `expected_version`；响应后回读实体、当前 revisions 和存储绑定。
5. 任一步失败都停止并记录补偿清单；不得只看到目录 URL 或存储 200 就计为合规封面。

线上 `Picture` DTO 没有 `asset_id` 或许可字段，授权范围/期限/合同引用须保存在 Catalog DTO 之外的审查证据包。
