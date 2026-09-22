# 模型表达不了的事实清单与上报路径（面向 Agent）

本文件列出**技能写全也表达不了**的事实，以及遇到它们时该怎么做。
这些不是"写法问题"，也不是"再试试别的字段"能解决的：下表所依据的种子 definitions + 校验 + 关系码集合里没有落点。目标实例可能已通过后台定义 GUI 扩展，报告前仍须读取其已发布定义。

**遇到缺口时的唯一正确处理**：不要用近似数据填充（那是把错误固化成"事实"，并污染后续查重与谱系），
在报告里按"**实现缺口**"分类写明"实体 + 想表达的事实 + 现有字段为何不够"，然后给出扩展建议。
报告格式见 [metafusion-curator SKILL](../metafusion-curator/SKILL.md) 的"审查结论格式"。

## 种子定义表达不了的事实（按实测撞上的领域数排序）

| # | 事实 | 为什么落不下 | 常见近似（有损，需在报告里注明） |
| --- | --- | --- | --- |
| 1 | 漫画、舞台剧/音乐剧、实拍电视剧、纪录片、商业主机游戏的作品类型 | work 只有 10 个类型码（`album`/`song`/`music`/`animation`/`film`/`novel`/`visual_novel`/`indie_game`/`photobook`/`personal`），**没有 `manga` 等码**；类型码同时决定能写哪些属性 | 漫画落 `novel`、商业游戏落 `indie_game`（可写字段会跟着错） |
| 2 | 载体与技术规格：区码、分辨率、音轨编码（LPCM/DTS-HD）、字幕语言、碟容量；黑胶 A/B 面；8cm CD / UMD / Vita 卡 / 游戏卡匣等 format | `medium` 只有 `catalog_number`/`format`/`role`；`format` 词表只有 10 项；没有面位字段 | 写进 `attachments`（语义是包装附件，且 `label` 必填）；面位写 `track.number = "A1"`；碟号只能进题名 |
| 3 | 发行侧真实事实：頒布イベント（コミケ / M3 / マジカルミライ）、厂牌系列、代理销售渠道、官方版名（"The 3rd Mini Album"）、收录范围区间（"第1話－第3話"）、整碟时长 | `release` 字段集里没有这些码 | `edition_batch`/`attachments`/`events` 近似；版名只能写进 `title` |
| 4 | 收录语义：普通专辑收录自己的曲目、盒装把两张可独立购买的专辑打包 | `release_role` 只有 `primary`/`compilation`/`supplement`，**缺"收录曲 / constituent"档** → 自己的曲目只能标 `compilation`（读起来像"本作品是合辑"），盒装两张独立专辑只能都标 `primary` | 用 `compilation` 硬标并在报告里说明语义偏差 |
| 5 | 定位锚点：页码锚到"第几卷/正文"、CD 数字轨 | `locator.relative_to` 词表只有 `medium` / `track`；`vinyl_track_locator` 场景 `enabled=false` | 锚到 `track`/`medium`（语义变粗） |
| 6 | 关系端点：分盘/分轨署名（Disc 2 的指挥、某轨的编曲）、"某话改编自原作第 N 话"、角色↔角色关系、"盒装收录早先独立发行的专辑"、制作人/ported_by/localized_by/"演奏曲目→原曲" | `track` 不能作任何关系端点；`medium` 只能作 `bonus_included_in` 的 target；`content_unit` 不能作 target；`agent→agent` 只有 `member_of`；`release→release` 只有 `pressing_of`（语义是再版） | 为每轨/每话建 `expression` 把署名挂上去（粒度够但表达层暴涨）；或挂到 release/work（断言变粗） |
| 7 | 收录附加属性与发行对象附加属性（"本曲原出自哪张专辑/哪一年""这条收录在该发行里的角色说明"） | `inclusion_attributes` / `subject_attributes` 是**空组**，`contents[].attributes` / `subjects[].attributes` 写任何键都 `unknown_field` | 用 `locator` 或 release `attachments` 近似（语义不符） |
| 8 | 主体自身事实：人物生卒、团体成立/解散日、虚构角色设定 | `person`/`group`/`organization`/`character` 的 `fields` 全为空，agent 没有任何属性字段 | 只能挂到关系边上（`member_of` / `credit_for` 的 `begin_date`/`end_date`），"该团体成立于 1998"这种主体断言无法表达 |
| 9 | 受控标签落在发行/载体/轨道上（"初回特典""活动限定""Amazon 特典""初回盘"） | `tags` 只出现在 10 个 work 类型上 | `edition_type`/`edition_batch`/`attachments`/`store_bonuses` 近似 |
| 10 | 篇目级事实：单集/单话时长、场馆、章节首发日、游戏章节/更新包日期、公演场次 | `content_unit` 只有 `language`/`entry_role`/`air_date` | 时长留在 `track.duration`（强绑发行版）；公演场次塞 `expression.version_label` 自由文本 |
| 11 | 同一表达同时属于多个篇目（既是"专辑第 N 曲"又是"某影片乐段"） | `expression.content_unit_id` 是单值 | 二选一，另一侧留空 |
| 12 | 同一作品的多种编排（Web 版 24 章 vs 文库版 26 巻） | 没有"编排维度"，只能平铺 content_unit，`position` 会重叠 | 平铺并接受 position 重叠 |
| 13 | 外部 ID 的语义细分：`musicbrainz` 一个码同时服务 work / release-group / recording；`steam` 预设 category 固定为 `work` | 预设无语义区分；写到 release 上直接 `invalid_external_category` | 只写 category 允许的那一层，其余写进 `infobox` |
| 14 | 实体删除与归属迁移 | 没有 `DELETE /api/catalog/entities/{id}`；`immutable_scope` 让错挂父级的实体只能"重建 + 停用"，历史修订与悬挂边留在库里 | 重建 + lifecycle 停用，并在报告里留痕 |
| 15 | 清理停用实体的关联边 | `canEditEntity` 对 `deleted`/`merged` 先返回 false，`DELETE /api/catalog/relations/{id}` 恒 403 | 无法清理，按实例侧缺口上报 |

## 服务端不拦、但会漂移数据质量的项

这些模型支持、服务端不拒绝，靠自检与约定兜住（`scripts/check_data.py` 把它们列入 P1）：

- `release` 可以零 `medium` 入库（`release_without_medium`）；
- `subjects` 可以为空（不是必填字段，"发行里像必须有 subjects"是误读）；
- 同一 `medium` 下多张 `track` 的 `position` 可以重复，服务端不拦；
- `contents[].position` 只在自己那个 Track 内唯一，跨 Track 的曲序由 `track.position` 表达。

## 上报与扩展通道

事实确实需要新字段/新关系码时，正确的路径是**改 definitions**（管理员权限），不是绕接口：

1. `POST /api/admin/catalog-definitions` 建定义草稿（权限 `catalog.definitions.manage`）；
2. `…/{id}/impact` 评估影响面；
3. `…/{id}/publish` 发布，之后新字段码才对写入生效。

定义里的名称（类型/字段/词表/关系正反名/模板分区/场景，以及货架、外部库的 `names`）**必须四语齐备**
（`zh-CN`、`zh-TW`、`en-US`，加 `ja` 或 `ja-JP`），否则 `four_locale_names_required`。
注意 `names` 与实体的 `translations` 是两套形状，别混用。

**Agent 的默认动作不是去建字段**：先把缺口写进报告，由有权限的人决定是否扩展模型；没有授权时不要动定义。

## 实例侧已知缺口（不是技能的问题，报告时不要误判成自己的载荷写错）

- `POST /api/importer/preview` 对 `entity_type=artist` **静默回退为 `work`**（200），与实例自带 openapi
  的"不静默回退 work"描述矛盾；
- 读端点容忍坏令牌（当匿名 200），写端点同令牌 401 —— 诊断时不要据此认为"我的令牌还有效"。
  **PAT 是例外**：`mfp_` 前缀走内省，无效 / 吊销 / 过期在读端点也返回 `401 invalid_token`；
  账号服务不可达返回 `503 auth_unavailable`（见 [接口归属与写入范围](reference-endpoint-scope.md)）。
- 停用实体后其关联边无法删除（403）；
- `release.attributes.publisher` 等 **entity 型引用必须指向可见实体**：指向他人的 draft 会 `invalid_reference`，
  而 `?q=` 检索会返回 draft；
- 列表接口在分页边界可能重复返回同一实体，客户端建本地索引必须按 `id` 覆盖。

这些属于实现侧问题：按"实现缺口"上报，不要绕接口改库，也不要用近似数据填。

## 写库前的自检脚本

主仓库的 `scripts/check_data.py`（只读）会按定义驱动做一次全量体检，**分级只由脚本决定**：

- **P0 / P1 = 拦门**：脚本报出的 P0/P1 视为发布前必须处理，脚本退出码 1 即表示存在 P0/P1；
- **P2 = 只报告**：计数但不拦门（名称四语一类问题在这里）；
- 检查项与判据写在脚本自己的 docstring 里，不在这里另抄一份。

```bash
BASE=https://<实例> TOKEN=<会话令牌或 PAT> python scripts/check_data.py   # 跑一次，看本次分级与明细
```

**这里刻意不抄码表**：码名与分级是脚本里的字面量，抄进正文就会在两仓之间静默漂移——脚本改了分级或码名，
技能照旧拦门，Agent 会误判。要当前生效的「分级 → 码」映射，直接问脚本源码：

```bash
git -C <主仓库> grep -o -E '\("P[012]", "[a-z_]+"' -- scripts/check_data.py | sort -u
```

报告里引用某个码时，以脚本当次实际输出的码与分级为准，不要凭记忆写。

发布前跑一次，能提前发现服务端不拦、但会让数据漂移的问题；脚本不可用时在报告里标注"未执行"。
