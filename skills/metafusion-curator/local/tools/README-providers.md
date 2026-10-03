# 来源与提供方支持矩阵

本页是外部来源和出版方支持范围、凭据要求及失败判读的唯一文档入口。命令、参数与返回 schema 以 `mf-source` 的帮助输出为准；本矩阵描述连接器范围，不保证提供方此刻可用。查询到页面或记录也不自动满足 CORE-P1，须按[字段级来源策略](../../reference-source-policy.md)逐字段核实。

除下表列出的环境变量外，注册连接器未声明需要 API key；来源列表中的 `anonymous` 表示无需提供方凭据。连接状态只由单次读取结果报告，`list` / `help` 不做连通性探测。

## 官方来源与出版方页面

| 来源 | 连接器覆盖 | 输入与结果注意事项 |
| --- | --- | --- |
| Universal Music Japan | `umj.product` 官方商品页 | 输入 `artist-slug/product-code` 并严格核对页面品番。结果含 `image_urls` 候选和 `field_status` 字段状态；按字段复核，不据此自动认定图片或曲目归属。 |
| Pony Canyon、Canime、Sony Music | `publisher.pony_canyon`、`publisher.canime`、`publisher.sony_music` 官方产品页 | 输入形式查工具 help。页面缺字段时按未核实处理。 |
| Bushiroad Music（`bushiroad_music`；别名 `bushiroad`） | `publisher.bushiroad_music` 商品页 | 示例 `node mf-source.mjs run publisher.bushiroad_music BRMM-11078` 查询同页候选 BRMM-11077/11078。品番直达失败时扫描官方目录 ACF（非 WordPress search）；`requested_catalog_number` 保留请求品番，多版时 `catalog_number` 为 `null`，`catalog_candidates` 形如 `{edition,catalog_number}`。 |
| BanG Dream（`bang_dream`；别名 `bangdream`） | `publisher.bang_dream` Discography 页面 | 只接受 HTTPS `/discographies/{numeric-id}/` 完整 URL；URL 未提供品番时 `requested_catalog_number` 为 `null`。多版时 `catalog_number` 为 `null`，候选见 `catalog_candidates`（`{edition,catalog_number}`）。 |
| Wikidata、Bangumi、MusicBrainz | `wikidata.*`；`bangumi.*`；`musicbrainz.*` 搜索或记录读取 | 搜索结果是候选；核对 kind、具体作品/版次与身份锚点。它们作为聚合或编目来源不能仅凭站点名升级为 CORE-P1。 |

Bushiroad Music / BanG Dream：`price` 保留来源原始字符串，仅唯一明确归版时填写，否则为 `null` 并保留 `price_candidates`；不按价格顺序猜版。候选项为 `{edition,catalog_number,amount,currency,tax_included,raw}`，`raw` 是来源价格原文；日元（`円` / `¥`）为 `JPY`，币种不明时为 `null`，`tax_included` 为 `true` / `false` / `null`。`field_status.price` 为 `source_reported_unverified` / `multiple_editions_ambiguous` / `not_found`；`image_urls` 不自动归版。来源采集价格是证据，不表示目标 Release `attributes` 已有定价落点。

## 外部编目与登记连接器

| 提供方 | 支持范围 | 凭据 |
| --- | --- | --- |
| Discogs | `discogs.release`、`discogs.master`、`discogs.search` | 无连接器 key；图片可能由社区上传。 |
| Open Library | `openlibrary.search/work/edition/editions/author/isbn` | 无连接器 key。 |
| Internet Archive | `archive.item/search/wayback`；可为 VGMdb 读取存档 | 无连接器 key。空元数据需按连接器判读，不能只看 HTTP 状态。 |
| TMDB | `tmdb.movie/tv/search` | `TMDB_API_KEY` 或 `TMDB_ACCESS_TOKEN`。 |
| AniList | `anilist.media/search` | 无连接器 key；聚合内容仍按来源策略分级。 |
| MyAnimeList | `mal.anime/search` | `MAL_CLIENT_ID`。 |
| ISNI Registry、VIAF | `isni.record`、`viaf.record` | 未声明连接器 key。失败响应可能来自网关、代理或解析变化；仅连接器校验后的明确 `found:false` 表示未找到。HTTP 状态本身不作结论。 |
| OCLC FAST | `oclc.fast`：只读公开 FAST suggestion 查询，不实现带认证的 WorldCat API | 不读取 WorldCat 凭据。FAST 端点可能拒绝请求或发生变化；拒绝/解析失败按未知处理，不能据此声称 WorldCat 记录不存在或“配置 key 后即可用”。 |
| NDL Linked Data | `ndl.authority` | 无连接器 key；范围限权威记录，不代表 NDL 全部书目或检索服务。 |
| VGMdb | `vgmdb.album`、`vgmdb.archive` | 无连接器 key。直连拦截或无可用存档都属于未知/不可读取，不代表记录不存在；社区资料仅作候选。 |

## 失败与证据判读

- 只把连接器明确验证为未找到的结果视作 `found:false`。对 ISNI / VIAF 尤其区分登记记录缺失与网关 404、反爬页或响应格式变化；`2xx` 或 HTTP 404 均不能单独证明有/无记录。
- 凭据缺失、401/403、限流、网络/超时、5xx、反爬、网关错误和解析失败都不是“没有数据”。依结构化错误的 `kind` / `retryable` / `hint` 处理；状态不明时停止依赖该结果的写入。
- 检索返回的是候选。写目录前复核实体 kind、父级作用域、身份锚点、发行版和来源实际支持的字段；不要把 `raw`、图片 URL 或曲目原文直接视为已核实事实。
- 连接器只读取外部来源，不向来源站发送 MetaFusion PAT，也不写目录库。提供方自己的 key 通过对应环境变量提供，变量名见上表；不要展示或记录密钥值。
- 速率限制和端点可用性可能变化；按工具提示与本次响应退避或换已支持的来源路径，不沿用历史 smoke 输出作为当前事实。
