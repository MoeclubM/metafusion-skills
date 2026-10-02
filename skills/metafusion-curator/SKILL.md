---
name: metafusion-curator
description: 执行 MetaFusion 跨媒介实体编目、查重、发行载体维护、关系审查和数据质量复核。用于创建、编辑、导入、合并或审核 Agent、Collection、Work、ContentUnit、Expression、Release、Medium、Track 及实体关系。
---

# MetaFusion 编目与审查技能

本技能处理目录数据的读取、编目与审查；写入限于用户已授权的实例和对象。开发、部署与真实数据操作是不同范围。

## 先确认目标与契约

- 目标实例统一使用 `/api`。先核对 `GET /api/openapi.json`、`GET /api/catalog/definitions`、目标实体和调用者权限；版本或身份不明时停止依赖写入。
- [API 行为参考](reference-api-behavior.md)记录载荷与校验；参考页里的种子码表是对照，不是目标实例的当前配置。只有当前启用的字段、词表、关系码能用于写入。
- 本机源码服务可使用仓库已有契约核验脚本；先检查路径与 `--help`，传明确本地 URL。源码扫描不能替代目标实例的运行时核验。
- 技能与响应矛盾时记录 URL、核验时间与差异，并暂停受影响写入；不绕接口改数据库。

## 按任务读取参考

| 当前任务 | 优先读取 |
| --- | --- |
| 判断系统归属、权限与实体可见性 | [接口归属与写入范围](reference-endpoint-scope.md) |
| 证明身份、核心字段、当前修订或封面权利 | [字段级来源与权利策略](reference-source-policy.md) |
| 选择创作、篇目、表达、发行、介质与轨道层级 | [实体与层级数据模型](reference-data-model.md)；命名问题再读 [LRM 与发行版规范](../lrm-catalog-standards/SKILL.md) |
| 填写动态属性、locator、附件或外部 ID | [字段适用层级与结构化字段](reference-types-and-fields.md) |
| 建立署名、改编、聚合等关系 | [关系码、方向与属性](reference-relations.md) |
| 准备 API 请求或处理拒绝 | [载荷模板](reference-api-templates.md)、[错误码与修复动作](reference-api-errors.md) |
| 上传或绑定文件 | [文件上传与绑定](reference-file-upload.md) |
| 写后复核、完整性审计或模型表达缺口 | [质量检查清单](reference-qa-checklist.md)、[模型缺口与扩展通道](reference-model-gaps.md) |

按本次任务读取对应参考，不要求每次加载全部码表。共享事实只在对应参考维护，入口不另抄关系或字段全集。

## 本地客户端与工具

本机 Agent 可直接读写已忽略的 `local/credentials.json`，并用 `local/metafusion-api.mjs` 调用目标实例。令牌值不进入对话、日志、报告或提交；正常本地调用无需轮换凭据。任务直接复用这个客户端，不再按批次生成脚本；格式见 [本地凭据与通用客户端](local/README.md)。

审计与合并等反复要用的只读/编辑动作，收敛在 [local/tools/](local/tools/README.md)（全站质量审计、层级合规、外部标识同一性、来源线索与并集合并）。**先看有没有现成工具，不要再按批次新写脚本**；合并默认 dry-run。工具输出只代表它实际检查的项目，不能代替来源核验或证明跨实体事务。

## 编目决策与写入约束

- 按 **kind + 原题名/别名 + 父级作用域 + 已核验的内容身份**，辅以官方编号、条码、外部 ID 与实际关系查重。标签只作线索，同名不证明同一对象；复用独立歌曲 Work 和录音 Expression，避免按专辑重复建歌。
- 核心字段与身份结论须逐字段 CORE-P1；P2/Wiki 用于发现与辅助。来源策略、当前版本资格和封面权利沿用对应参考，不用站内旧值、搜索摘要或模型记忆补证。
- 核到官网后，除记录 `sources`，还将完整 URL 写入 `external_ids.official_website`；前端官方链接读取此字段。没有可核实官网就留空，不用渠道页代替。
- 创作目录与发行承载分开；Release 的 `subjects` 覆盖 Track 实际收录 Expression 的全部 Work。整本/整季表达组合与显式版本组使用实例声明的关系用途；共同 subjects 不证明属于同一版本组。结构归属用固定字段，语义关系与属性使用目标实例的当前生效 definitions。
- 编目事实只写目录；互动走 community、文件走 storage，定义管理须在已授权范围内。实体可见性与引用有效性以目录读接口为准：404 表示当前调用者不可读取该对象，不能据此断言全库不存在；401/403、429、5xx 或网络失败均为未知，停止依赖写入。
- 实体 PUT 是整实体替换：先 GET，保留所有未修改的可写字段，携带 `expected_version`。实例支持时，单条收录用 Track contents 编辑接口并取 Track 版本，避免覆盖其余收录；契约见[载荷模板](reference-api-templates.md)。409 后回读和比对，不盲重放。创建实体/关系使用唯一 `Idempotency-Key`，同键只能重放原载荷。
- 每次写入提供具体 `edit_note` 与 `sources`；服务端接受证据信封不证明字段级权威性。发布、下架、合并与停用依 [API 行为参考](reference-api-behavior.md)选择端点和权限。
- 写后回读实体、当前修订、关系与 occurrences，逐字段核对版本、来源、层级和未请求修改的数据；客户端的成功标志不能替代这一步。
- 碰到缺字段或关系，先读实例 definitions 判断是否已有 GUI 扩展；确无落点则报告缺口，不借不符语义的标签、伪造归属或直接 SQL 填充。已获授权的定义管理可走后台 GUI 的编辑、影响检查与 `expected_etag` 保存流程，接口见[模型缺口与扩展通道](reference-model-gaps.md)。

## 审查结论格式

按“通过 / 需补证据 / 需修正 / 实现缺口”记录实体、字段、当前版本、来源、影响和建议动作；未执行标“未核验”。完整性与计数采用 [来源策略](reference-source-policy.md)的资格字段，不把工具的“0 问题”当成完整证明。关系长路径、并发与遍历截断只报告已验证范围。
