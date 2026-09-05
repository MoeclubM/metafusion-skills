# MetaFusion 当前实现契约

本文件记录与 MetaFusion 主仓库当前 main 实现相匹配的运行时边界。它是编目技能的实现参考，不替代部署实例返回的 OpenAPI 描述。使用技能时，如果目标实例的 /api/v1/openapi.json、迁移或处理器与本文件不同，以目标实例为准，并在结果中注明差异。

## 版本与读取顺序

- 本快照对应主仓库在 2026-09-05 附近的 000004_content_hierarchy、000005_carrier_hierarchy、000006_carrier_content_integrity 迁移及 routes_catalog.go。
- 先确认 API 前缀、认证方式和实例版本，再读取 /catalog/taxonomy、/catalog/relation-types 与目标实体详情。不要从示例中的枚举、默认值或错误码反推当前服务器行为。
- 数据库迁移、Go 处理器和 OpenAPI 冲突时，按“实际运行处理器 + 已执行迁移 + 响应”核对；不要用 SQL 绕过 API 约束。

## 当前实体边界

| 实体 | 当前职责与不可破坏的归属 |
| --- | --- |
| Work | 创作母体。title 保持纯题名；original_language、基础简介、作品级标签和创作主体归于此处。 |
| CanonicalEntry | 作品内容目录中的表达、篇目或母版。必须属于一个 Work；parent_id 只能指向同一 Work，不能迁移已有篇目到另一 Work。 |
| Release | 一个具体发行版，必须属于一个 Work，承载 edition、厂牌/出版者、条码、品番、包装、日期及发行版封面。 |
| Medium | Release 内真实存在的盘、卷、文件集或其他容器；parent_id 只能指向同一 Release 的 Medium。 |
| Track | Medium 内的位置项。服务端根据 Medium 所属 Release 推导并校验 work_id；不要把它当作作品内容目录。 |
| TrackContent | Track 收录的一个或多个 CanonicalEntry 及其 position / locator。仍需与 Track 所属 Release 的 Work 一致。单内容旧数据可用 tracks.canonical_entry_id 读取。 |
| AssetFile | 由资产注册/绑定层管理的文件与哈希；不要把下载 URL、文件名或处理状态塞进 Work 标题。 |

当前 000006 明确拒绝跨 Work 的 Track 或 TrackContent。它保证归属一致，但无法直接表达一个发行版同时收录多个独立 Work。遇到实体全集或多作品盒装时，禁止把盒装品番挂到其中一部作品，也禁止用外键、触发器或直接 SQL 绕过约束；如果实例没有显式的汇编模型，应把需求标成模型缺口，保留可核实的独立发行信息，等待产品层扩展。

## 多语言数据形状

- Work、Artist、Franchise 的 translations 是数组，项目级字段分别使用 locale + title/name + summary/biography。
- Release 的 translations 是 JSON 对象，值只应包含 edition_name、notes；Medium 只包含 name；Track 只包含 title；CanonicalEntry 只包含 title、version_label。
- 读取回退顺序为请求 locale → en-US → 实体 original_language → 基础字段。标签、关系类型、角色、介质格式和包装名称来自 taxonomy / relation-types，不在客户端重新硬编码。

## 写入接口的实际边界

公共读取常用 /catalog/works/:id、/catalog/works/:id/contents、/catalog/works/:id/graph、/catalog/releases、/catalog/canonical-entries、/catalog/mediums。认证写入使用 /catalog/works、/catalog/releases、/catalog/canonical-entries、/catalog/mediums、/catalog/tracks，以及关系接口。

- CanonicalEntry、Medium、Track 的成员写入校验非空 edit_note 与至少一个合法 HTTP(S) source_urls；Carrier 翻译字段按上表限制。
- Release 成员写入也校验证据；字段名是 edition_date、duration_seconds、contents，不要套用旧示例中的 release_date、duration 或仅一个 canonical_entry_id。
- Work 创建处理器当前没有同等的证据必填校验，Work 更新会记录 edit_note / source_urls。技能政策仍要求代理在提交前收集证据，并在报告中指出服务器未强制的差异。
- PUT /catalog/entity-relations 当前请求体只接收 relations；不能声称该接口已经写入 edit_note、source_urls 或 admin_audit_logs。若审计是硬要求，应先修复服务端或使用已有的可审计端点。
- POST /catalog/submit 是兼容性的综合导入路径；其当前输入结构不包含审计字段，内部步骤也不是可据此假设的全量 ACID 事务。需要可追溯写入时优先使用粒度端点，提交后重新读取并检查 revisions。

## 写后核对

每次写入后重新 GET 目标实体及其父子关联，检查 Work 归属、父节点、position 唯一性、翻译回退和修订记录。关系图写入还要重新读取边并在客户端检查自环、反向重复和长路径；如果服务端版本已知存在遍历截断或并发校验限制，不要把“请求成功”描述成全库 DAG 已证明。
