# 编目工具（mf-*）

本目录是 metafusion-curator 的可复用编目工具，**MetaFusion 请求统一通过上级目录的 `metafusion-api.mjs`**
（PAT 认证、只在有凭据时联络实例）。外部标识工具另行匿名读取提供方 API，不向外部网站携带 MetaFusion 凭据。

## 为什么在这里

技能 `SKILL.md` 要求"任务直接复用客户端，**不再按批次生成脚本**"。一次真实数据补录战役下来，
按批次生成的脚本会迅速退化成十几份 80% 重复的实现（各自登录、各自重试、各自判断"数据有没有问题"）。
这里把它们收敛成五个工具 + 一个共享库。

## 文件

| 文件 | 作用 | 写不写线上数据 |
| --- | --- | --- |
| `mf-lib.mjs` | 共享原语：读取、分页、关系、**预检与并集合并引擎**（类型/身份/版本/方向守卫，显式报告非原子与部分完成） | 否（库） |
| `mf-audit.mjs` | 全站质量审计：缺封面/缺语种/断链/未覆盖 subjects/裸母体/孤儿/同作用域重复组 | 否 |
| `mf-check-structure.mjs` | 实体层级抽样检查：创作链、承载链、跨链引用、当前启用关系端点规则 | 否 |
| `mf-audit-external-ids.mjs` | 外部标识同一性：核验 `external_ids.<provider>` 是否指向同一对象 | 否 |
| `mf-audit-provenance.mjs` | 历史来源线索：按创建时 edit_note 找候选；不核验当前字段权威性 | 否 |
| `mf-merge.mjs` | 合并已核证的同作用域重复（默认 dry-run；实际写入须 --sources） | **是（仅 `--apply`）** |

## 通用约定

- 质量审计与合并输出默认 `docs-local/data-quality`；历史来源线索默认 `docs-local/data-campaign/logs`。可用 `MF_AUDIT_OUT` 覆盖；本工具不写实例配置。
- 列表/定义读取失败停止检查，不退化成空库通过；逐条关系或历史来源读取失败明确记“未知”，报告不能计作完整。
- `401`/`403`、`429`、5xx 与网络失败属于未知；`404` 只表示当前调用者不可见或资源不存在，不能推出全库缺失。
- 参与"身份"判定的字段：`external_ids` 的 bangumi/musicbrainz/wikidata/anilist/isrc/… 与
  `attributes` 的 duration/edition_date/barcode/isbn/catalog_number/edition_type。
  **同键异值即拒绝合并**——同名不等于同一物（库里确实同时存在"歌曲"与"其所属专辑"同名的情况）。
- `mf-audit` 的同名同作用域结果仅为候选；它不核验当前修订的逐字段 P1、图片使用权或同一对象身份。`mf-audit-provenance` 仅检查最早备注的历史线索，不能证明来源通过或不通过；未知项另列。
- 合并库预检两端 kind/标题/归属、版本、字段冲突及关系；同一表达不同 locator 会保留，反方向的独立关系不删除。冲突须先人工/调用方核证处理，不自动丢弃对侧值。
- 实际合并须传入已核验的 `url`/`publication` 来源，涵盖两端身份、保留字段及图片权利；不接受 `self`。来源形状校验不等于程序已核实官方内容。
- 合并分为并集 PUT、删除同方向重复边、lifecycle 三类独立事务；**不具备原子性**。任一步失败立即停止后续写入，日志记录 `atomic:false`、`partial`、`completedSteps`。不要自动回滚或把部分完成当作可安全重跑。

## 从哪里运行

输出目录默认是**相对当前工作目录**的 `docs-local/data-quality`。因此：

- 在**目标仓库根目录**下运行时，直接 `node <技能目录>/local/tools/mf-audit.mjs`，报告就落在该仓库的 `docs-local` 里；
- 在别处运行时，用 `MF_AUDIT_OUT=<目录>` 指定输出，避免在工作目录里留下意外路径。

## 用法

```bash
node mf-audit.mjs                                   # 可见目录的质量候选
node mf-check-structure.mjs                         # 结构抽样检查
node mf-audit-external-ids.mjs --provider bangumi   # 外链同一性（musicbrainz | bangumi）
node mf-audit-provenance.mjs                        # 历史来源线索
node mf-merge.mjs --from-report <gap-report.json> --kinds expression,track   # 先 dry-run
node mf-merge.mjs --from-report <gap-report.json> --kinds expression,track --apply --sources <sources.json>
```

`mf-merge` **默认 dry-run**，按依赖顺序处理（expression → content_unit → medium → track）；
遇 `status=merged` 跳过；这不保证此前的部分操作可以自动重跑，须先核对日志与当前对象。

`sources.json` 是标准来源数组，例如 `[{"kind":"url","url":"https://example.org/official-catalog","citation":"官方目录：支持两端身份及本次保留字段"}]`；示例 URL 不能作为真实证据。

隔离验证不读取真实凭据、不访问实例：

```bash
node --test ../metafusion-api.test.mjs mf-tools.test.mjs
```
