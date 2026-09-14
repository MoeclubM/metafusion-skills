# MetaFusion 子系统边界

本文件说明编目写入所依赖的各运行单元各自拥有什么、不拥有什么，以及跨系统交互的唯一合法通道。
契约来源是主仓库 `docs/architecture/service-split-migration.md`（唯一契约来源）与各服务仓库的 README 和源码。

## 运行单元与路由归属

| 运行单元 | 拥有数据（schema） | 对外路径前缀 | 仓库 |
| --- | --- | --- | --- |
| 元数据目录 catalog | 八类实体、动态定义、关系、结构、修订、检索、货架、外部权威库（`catalog.*`） | `/api/catalog/*`、`/api/importer/*`、`/api/openapi.json` | MetaFusion |
| 账号 auth | 用户、会话、OAuth 客户端/授权码/令牌、RSA 密钥（`auth.*`） | `/api/setup`、`/api/auth/*`、`/api/admin/users*`、`/api/oauth/*`、`/api/oidc/jwks`、`/api/.well-known/openid-configuration` | metafusion-auth |
| 互动 community | 论坛板块/主题/回复/标签、条目短评、收藏、互动记录（`community.*`） | `/api/community/*`、`/api/favorites/*`、`/api/records/*`、`/api/users/{id}/favorites` | metafusion-community |
| 存储 storage | 物理文件、sha256 内容寻址、对象存储直传、文件→实体绑定、下载与预览的访问控制（`storage.*`） | `/api/storage/*` | metafusion-storage |
| 边缘网关 gateway | 无（只有路由表） | `/`、`/docs`，按前缀分流到上述单元 | metafusion-api-gateway |

网关**按前缀分流**，不为切换服务而改前端调用点。`/api/users/{id}/favorites` 与用户资料同前缀，网关用精确正则
`^/api/users/[^/]+/favorites$` 单独分流到互动服务，其余 `/api/users/*` 仍归目录。

**编目者只写目录。** 论坛、短评、收藏、互动记录不是元数据事实：不要通过目录接口写入它们，也不要为它们在目录里建实体。

## 各系统负责什么

- **元数据目录**：八类实体的创建与编辑、动态类型/字段/词表/关系/模板定义、关系图、包含与发行结构、
  修订与生命周期（草稿 / 待审 / 发布 / 合并 / 停用）、检索与货架、外部权威库预设。它是"作品是什么"的唯一来源。
- **账号**：注册与登录、会话轮转、令牌签发与吊销、OAuth 2.0 / OIDC、账号与角色管理。
  **业务权限（谁能编辑哪个实体）由目录自己判断**，账号服务不介入。
- **互动**：论坛、条目短评、收藏、评分/进度/持有记录。它只保存用户互动，不保存实体元数据。
- **存储**：物理文件与哈希、直传、绑定、下载与预览。它**不保存**目录结构（不复制作品/专辑/曲目表），
  目录**不保存**对象存储物理路径。

## 跨系统交互规则

- 每个服务只读写自己的 schema；**禁止跨库 JOIN**。
- 服务间只通过 **HTTP 契约**交互；**禁止复制对方的表**——不复制作品/专辑/曲目表，也不把对方的实体可见性结论落库缓存。
- 判定"实体是否存在/是否可见"必须问目录：`GET /api/catalog/entities/{id}`。互动与存储都只调这一条
  （互动另用 `GET /api/catalog/entities/{id}/relations` 取关系邻居），可见性规则只有目录一处实现；非 200 一律按"不存在"处理。
- 令牌只在账号服务签发，其余服务**只验签**（RS256 + JWKS），只信 `sub` / `preferred_username` / `role`。
- 实体合并（`entity.merged`）会改写引用：裸 UUID 引用要用 `GET /api/catalog/entities/{id}/resolve` 解析当前身份，
  不要假定 ID 永久有效。跨服务的合并事件消费仍在演进，写入前应重新解析而不是信本地缓存。
- 迁移期例外：`/api/archive|playback|media` 与 `/api/community|records|favorites` 目前仍由单体（catalog）服务线上流量，
  网关按前缀切换；**编目写入始终走 `/api/catalog/*`**，不受切流影响。

## 与编目有关的三条判据

1. 目标前缀属于目录（`/api/catalog/*`、`/api/importer/*`）才是编目写入；其余前缀不属于编目任务。
2. 需要"这个实体存不存在/能不能看到"时调用目录的实体读接口，不要另建本地台账或复制一份表。
3. 需要给文件登记用途时走存储服务（见 [存储契约要点](reference-storage-contract.md)）：
   哈希、对象键与下载地址都不进实体题名或动态字段。
