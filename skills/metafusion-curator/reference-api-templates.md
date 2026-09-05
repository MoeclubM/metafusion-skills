# MetaFusion API 载荷参考

这是当前实现的最小载荷参考。提交前先读取 /api/v1/openapi.json（如提供）和 [当前实现契约](reference-runtime-contract.md)。认证、API 前缀和可用字段以目标实例为准。

## 请求头与证据

认证写入通常需要：

    Authorization: Bearer <token>
    Content-Type: application/json
    User-Agent: MetaFusionCurator/<version>

粒度编目写入都应准备：

    "edit_note": "根据官方发行目录补充初版蓝光的品番与分集目录",
    "source_urls": ["https://example.org/official-catalog"]

source_urls 必须是相关的 HTTP(S) 公共地址，不能带用户信息或凭证。当前服务端对部分端点只校验非空和 URL 格式，Agent 仍需自行判断来源是否真的支持该字段。

## Work

    POST /api/v1/catalog/works
    {
      "title": "秒速5厘米",
      "original_title": "秒速5センチメートル",
      "original_language": "ja",
      "summary": "作品级简介",
      "cover_aspect": "2:3",
      "cover_image_url": "/assets/covers/5cm.webp",
      "tags": ["动画", "电影"],
      "translations": [
        {"locale": "zh-CN", "title": "秒速5厘米", "summary": "中文简介"},
        {"locale": "en-US", "title": "5 Centimeters per Second", "summary": "English summary"}
      ]
    }

Work 创建处理器当前没有与载体端点相同的证据必填校验；编目政策仍要求先完成考据并保存 edit_note / source_urls。更新使用 PUT /catalog/works/:id，该路径会写入 Work 修订快照。

## CanonicalEntry

    POST /api/v1/catalog/canonical-entries
    {
      "work_id": "<work-uuid>",
      "title": "第 1 话：樱花抄",
      "position": 1,
      "number": "1",
      "entry_role": "main",
      "original_language": "ja",
      "translations": {
        "zh-CN": {"title": "第 1 话：樱花抄", "version_label": "中文版"}
      },
      "edit_note": "根据官方分集目录建立内容条目",
      "source_urls": ["https://example.org/episodes"]
    }

CanonicalEntry 的 translations 只允许 title、version_label；position 可以为 0，entry_role 使用实例支持的 main、extra 或 group。已有条目更新时不能修改其 work_id。

## Release

    POST /api/v1/catalog/releases
    {
      "work_id": "<work-uuid>",
      "edition_name": "日本官方初版蓝光",
      "catalog_number": "VWBS-1530",
      "barcode": "4988104044952",
      "edition_date": "2008-04-18",
      "publisher_id": "<artist-uuid>",
      "packaging": "box_set",
      "country": "JPN",
      "original_language": "ja",
      "translations": {
        "zh-CN": {"edition_name": "日本官方初版蓝光", "notes": "单碟发行"}
      },
      "edit_note": "根据发行方目录核对品番、日期和包装",
      "source_urls": ["https://example.org/release"]
    }

Release 的日期字段是 edition_date；release_date 是 Work 的创作/发行点字段。publisher_id 应指向已存在的 Artist / 机构主体。若实例允许直接 publisher 文本，也只在无法建立主体时使用，并在审查中说明。

## Medium

    POST /api/v1/catalog/mediums
    {
      "release_id": "<release-uuid>",
      "position": 1,
      "name": "Disc 1",
      "format": "Blu-ray",
      "media_category": "video",
      "role": "primary",
      "original_language": "ja",
      "translations": {
        "zh-CN": {"name": "第 1 张蓝光"}
      },
      "edit_note": "按盒内实物顺序登记主载体",
      "source_urls": ["https://example.org/package"]
    }

Medium 的 parent_id 只能指向同一 Release 的 Medium。format、media_category、role 优先从 /catalog/taxonomy 读取，不要把旧文档的示例列表写成固定枚举。

## Track 与 TrackContent

    POST /api/v1/catalog/tracks
    {
      "medium_id": "<medium-uuid>",
      "position": 1,
      "title": "第 1 话：樱花抄",
      "duration_seconds": 1560,
      "canonical_entry_id": "<entry-uuid>",
      "contents": [
        {
          "canonical_entry_id": "<entry-uuid>",
          "position": 1,
          "locator": {"chapter": "1", "timecode": "00:00:00"}
        }
      ],
      "translations": {
        "zh-CN": {"title": "第 1 话：樱花抄"}
      },
      "edit_note": "根据蓝光目录建立第 1 轨并关联分集",
      "source_urls": ["https://example.org/disc-1"]
    }

字段名是 duration_seconds，不是 duration。contents 是多内容收录关系；如果同时提供 canonical_entry_id，它必须与唯一的 contents 项一致。Track 的 work_id 可以省略，服务端会从 Medium 所属 Release 推导。

当前 000006 触发器和处理器都要求 Track、TrackContent、CanonicalEntry 与 Release 属于同一 Work。多作品盒装不能用外部 work_id 伪造跨作品 Track；没有 Compilation 端点时应记录模型缺口。

## EntityRelationship

    PUT /api/v1/catalog/entity-relations
    {
      "relations": [
        {
          "source_type": "work",
          "source_id": "<work-uuid>",
          "target_type": "work",
          "target_id": "<other-work-uuid>",
          "relationship_type": "adaptation_of",
          "qualifier": ""
        }
      ]
    }

先读取 /catalog/relation-types，使用启用关系和允许的 source / target 类型。当前这个成员路径的请求结构只接收 relations，不能把 edit_note 或 source_urls 当成已经落库的审计字段；审计是硬要求时应先修复服务端或采用实例明确支持的可审计路径。

## 综合导入

POST /api/v1/catalog/submit 保留用于兼容已有导入器。当前输入结构和内部写入步骤不能推断为接收审计字段或全量 ACID 事务。需要逐项审查、失败可恢复和修订可追溯时，使用上面的粒度端点；综合导入后必须重新读取 Work、Release、Medium、Track 和 revisions。

## 成功后的检查

不要只根据 2xx 响应判定成功。至少重新 GET：

- /catalog/works/:id 及 /contents；
- /catalog/releases?work_id=...；
- 相关 Medium、Track 和 TrackContent；
- /catalog/revisions?target_type=...&target_id=...。

核对返回的 ID、Work 归属、父节点、position、翻译回退、封面 URL 和 revision 内容。发现服务端响应与预期不同，停止后续依赖写入并报告差异。
