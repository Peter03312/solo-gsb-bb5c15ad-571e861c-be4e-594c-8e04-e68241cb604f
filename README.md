# 🎬 Subtitle Desk — 小团队视频字幕校对台

供小团队在**本机/内网**协作校对视频字幕的 Web 应用：浏览器时间轴上按毫秒增删改字幕片段、
实时预览、审校、发布不可变版本并导出 SRT。视频文件与 SQLite 数据全部保存在运行服务的本机磁盘。

## 功能一览

- **上传视频**：浏览器读取视频时长（毫秒）并与文件一起上传；服务端流式播放，支持 Range 拖动。
- **毫秒级片段管理**：在时间轴上点击定位，按「起点/终点（ms）」新增、编辑、删除字幕片段。
- **硬性时间规则**（服务端事务内校验，前端输入原样保留、原稿不动）：
  - 起点必须早于终点；
  - 终点不得超过视频时长，起点不得为负；
  - 同视频片段之间**不得时间重叠**（端点相接允许）；
  - 非法操作返回 `422` 与中文原因，编辑弹窗保持你未提交的输入，可修改后重试。
- **乐观锁修订号 `revision`**：
  - 每次修改（含审校、删除）都必须携带「所见修订号」；
  - 修订号过期返回 `409` 冲突与**当前片段内容**，绝不覆盖他人修改；
  - 前端 5 秒自动轮询他人改动（编辑弹窗打开时暂停），收到冲突弹窗可选择放弃或基于最新内容重编。
- **审校流**：片段有 `待审 / 已审` 状态；**修改已审片段的内容会自动撤销其审校状态**（仅切换审校状态不会）。
- **发布门禁**：至少 1 个片段、全部已审、时间全部合法才能发布。
- **不可变版本**：发布把当前片段整体快照存库；之后的编辑只影响草稿，历史发布版本永不改变。
- **译文轨道（单语言）**：每个视频可启用一个指定语言的译文轨道，译文逐段关联当前草稿原文片段：
  - 录入/修改/审校译文须同时提交**所见原文修订号 `segment_revision` 与译文修订号 `revision`**，过期拒绝（`409`）并返回当前原文与译文状态；
  - **修改译文会撤销其审校状态**；原文的**文字或时间**一旦被修改，对应译文即标记为**已失效**（仅切换原文审校状态不会），需按当前原文重新校对；
  - 删除片段、SRT 整稿替换、历史区间恢复产生的新片段**不沿用旧译文**（级联清除）；
  - 工作台片段表并列展示原文与译文两轨的待审/已审/已失效状态，可直接录入、修改、审校译文；
  - 启用轨道的视频只有在**每段原文已审、译文已审且译文对应当前原文**时才能发布；失败返回待处理片段清单，不生成部分版本；
  - 发布快照**同时固定两轨内容**；原有单语 SRT 导出与旧发布版本（无译文快照）完全不变；
  - 可导出**草稿**或**含译文的发布版本**的译文 SRT；译文缺失或失效时拒绝（`422`）并逐段指出。
- **SRT 导出**：下载时可选择「草稿」「最新已发布」或任意历史版本（`?version=draft|published|<版本号>`）。
- **SRT 导入（预览 → 确认）**：为已有视频导入本地 SRT：
  - 接受 UTF-8（可含 BOM）、CRLF/LF 混用、序号不连续、多行文本的标准 SRT；
  - 先**预览**解析结果（每个条目含 SRT 序号与原文件行号）以及与当前草稿的逐条时间冲突；
  - 再选择**追加到草稿**（有冲突时禁止）或**替换整个草稿**；导入片段一律为**待审**，已发布版本及其 SRT 不变；
  - 空文件、格式错误、负时间、起止倒置、越过视频时长、导入条目互相重叠时返回**具体条目与行号**，且绝不写入；
  - 预览与确认之间草稿若被任何人修改，确认返回 `409` 并要求重新预览，绝不覆盖他人更改；整批写入在一个事务内，要么全部成功要么完全不变。
- **历史版本区间恢复（预览 → 确认）**：把某个已发布版本在指定整数毫秒区间内的片段整体恢复到草稿：
  - 先**预览**：并列查看区间内「发布快照 vs 当前草稿」的字幕，以及确认后将移除、将恢复的片段清单；
  - 区间起点须早于终点且均在视频时长内；**边界不得穿过任一侧片段**（端点相接允许），穿过则拒绝并逐条指出片段与时间；
  - 确认后区间内草稿片段被移除，历史片段作为**待审新片段**写入（修订号从 1 开始）；区间外草稿片段及其修订号、历史发布版本与 SRT 导出语义均不变；
  - 确认的版本与区间须与预览一致；预览后草稿发生任何增删改或审校变化，确认返回 `409` 并要求重新预览；
  - 版本不存在、区间越界或替换后时间线不合法时不写入任何内容；整批恢复在一个事务内原子完成。
- **多片段整体平移（预览 → 确认，用于校准字幕时间）**：勾选同一视频的多个原文片段，统一加上同一个非零整数毫秒偏移：
  - 先**预览**每段「调整前 → 调整后」时间，以及与未选片段的时间冲突、是否越过视频边界（端点相接允许、所选片段相对间距不变）；
  - 再以**相同的片段选择与偏移 + 预览令牌一次性确认**；任一片段越过视频边界或与未选片段重叠都拒绝且不写入，整批应用在一个事务内原子完成；
  - 成功后**仅移动所选原文片段**：时间加上偏移、修订号逐段 +1、撤销原文审校（文字不变）；未选片段完全不动；
  - 所选片段的**译文保留文字但标记为「已失效」**，须按新时间重新校对并再审；发布门禁与译文 SRT 导出据此阻止直接发布；历史发布版本及其原文/译文 SRT 导出结果保持不变；
  - 空选择、重复或不存在的片段 ID、非整数/为零偏移都返回明确的 `422` 错误；预览后草稿发生任何增删改或审校变化，确认返回 `409` 并要求重新预览。
- **片段拆分（长字幕一分为二，原子完成）**：把单个草稿片段在**严格位于其起止之间的整数毫秒切点**处拆成左右两段：
  - 提交左右两段**非空原文**；启用译文轨道时须同时提交同语言左右两段**非空译文**——不能丢弃原译文，也不得把原译文直接复制到任一段，须按拆分后的原文重新翻译；
  - 拆分原子完成：**原片段 ID 保留给左段且修订号 +1，右段获新 ID**（修订号从 1 开始）；两段原文及译文均转**待审**；
  - 既有质检放行随片段时间/文本变化**失效**（历史理由保留可查），质检规则按新时长重新计算；历史发布版本及其 SRT 不变，草稿、发布门禁与导出反映拆分结果；
  - 提交须携带所见原文修订号 `revision`（该片段已有译文时还须携带译文修订号 `translation_revision`），过期返回 `409` 与当前状态且零写入；非法切点、空文本或译文缺失同样零写入。
- **质检（QC）阈值、逐段报告与单项放行**：
  - 每个视频可分别为**原文**与**已启用译文**轨道配置 `最大每秒字符数（CPS）` 与 `最大单行字符数` 两个阈值；阈值必须为正数（单行字符数为正整数，CPS 可为小数），留空/`null` 表示该项不检查；
  - **按 Unicode 码点计数**（emoji 等代理对算 1 个字符）；**换行不计入速度**，速度 = 非换行字符数 ÷ 片段时长（秒，`(end_ms-start_ms)/1000`）；单行字符数按换行切分后取最长行；
  - 质检报告**逐段列出轨道、实测值、阈值与违规项**（含中文说明、所在行号、字符数、时长），工作台点击时间即可**定位**到该片段；
  - 对**单项违规可填写理由放行**；放行绑定放行时的**片段时间、文本、轨道语言与当时阈值（规则修订号）**，任一变化后放行自动**失效**（不会因内容改回而复活），但失效放行与理由**作为历史保留**可查；
  - **发布时服务端重新质检**：未放行的违规阻止发布、返回完整违规清单且**不产生版本**；成功发布的版本可查到**固定的规则、质检结果与有效放行**（发布后再改草稿不影响版本快照）；
  - **原有审校门禁始终适用**（未审/译文缺失/失效/待审照样阻止发布）；**未配置阈值的轨道不增加任何阻断**；**译文未启用时只检查原文**；旧发布版本（无质检快照）及其 SRT 导出行为完全不变；
  - 规则与放行都走**乐观锁并发控制**：规则修改携带 `rules_revision`（首次传 `0`），译文放行同时携带原文/译文双修订号；过期提交返回 `409` 与当前状态，绝不覆盖他人修改；规则阈值变化会使既有放行整体失效（历史保留）。
- **说话人名单与片段归属（按视频维护）**：
  - 工作台可按视频**增、删、改说话人名单**；名称**去首尾空白**后不得为空、不得含换行、同视频内**不得重复**（跨视频同名允许）；
  - 每个草稿原文片段可**归属到一名说话人**（也可置回未归属）；**拆分出的左右两段沿用原归属**，**SRT 导入与历史区间恢复产生的新片段一律未归属**；
  - 名单的增删改携带**所见名单修订号 `list_revision`**（首次传 `0`），归属修改携带**所见片段修订号 `revision`**；过期返回 `409` 与当前名单/片段状态，绝不覆盖他人修改；
  - **仍被草稿片段引用的说话人不得删除**（`422`，返回引用片段清单），须先把相关片段改归属到他人或置为未归属；
  - 成功归属使**片段修订号 +1 且原文转待审**，但**原文文字与时间不变**；因此**译文不会仅因归属变化而失效**（译文仍只因原文文字或时间变化而失效），译文审校状态保留；
  - **视频存在说话人时，未归属片段阻止发布**，失败返回逐段清单（原因 `speaker_unassigned`，不产生版本）；没有说话人的视频门禁与旧版本完全一致；
  - 成功发布**固定当时的说话人名称与逐段归属**（说话人快照）；之后改名、增删说话人或修改草稿归属都**不影响历史版本**（草稿立即显示新名）；可查询任一发布版本固定的说话人快照；
  - **原有 SRT 导出（原文/译文、草稿/历史版本）与旧发布版本语义完全不变**：SRT 不含说话人信息；无说话人名单时发布的旧版本没有说话人快照。

## 一键启动（Docker Compose，推荐）

需要 Docker 与 Docker Compose v2。

```bash
docker compose up -d --build
```

启动后访问：

- **应用地址**：http://localhost:8080
- **监听端口**：容器内 `8080`，宿主机默认映射 `8080:8080`

停止 / 查看日志：

```bash
docker compose down
docker compose logs -f
```

数据（SQLite 数据库 `app.db` 与上传的视频文件）保存在 Docker 卷 `subtitle-data`
（挂载到容器 `/app/data`），容器重建不丢失。

如不想用命名卷，可把 `docker-compose.yml` 中的卷改为绑定挂载：

```yaml
    volumes:
      - ./data:/app/data
```

## 本地直接运行（Node.js ≥ 20）

```bash
npm install
npm start
```

同样访问 http://localhost:8080 。数据默认写入项目下 `./data/`。

运行端到端测试（覆盖校验、冲突、审校撤销、发布门禁、不可变版本、SRT 导入/冲突/整批原子写入、历史版本区间恢复、多片段整体平移的越界/重叠拒绝/译文失效/门禁联动、译文轨道双修订号/失效规则/双轨发布门禁与快照/译文 SRT 导出，质检阈值配置/码点计数/逐段报告/单项放行/失效锁存/发布阻断与版本快照/并发拒绝，片段拆分的切点校验/双修订号/双段译文/复制禁止/放行失效/历史版本不可变，以及说话人名单 trim/去重/名单修订号/删除引用保护、片段归属修订号/转待审/译文不失效、未归属阻止发布与名称-归属快照不可变、拆分沿用与导入/恢复新片段未归属等 571 个断言），
以及数据库版本化迁移测试（新空库达到当前结构、旧库识别登记与全量数据保留、重复初始化幂等、
多进程并发同一迁移只生效一次、失败回滚并中止启动、升级后 HTTP 行为不变等 86 个断言）：

```bash
npm test
```

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | 服务监听端口 |
| `HOST` | `0.0.0.0` | 监听地址；仅本机使用可设 `127.0.0.1` |
| `DB_PATH` | `./data/app.db` | SQLite 数据库文件路径，首次启动自动建表初始化 |
| `UPLOAD_DIR` | `./data/videos` | 上传视频存储目录，自动创建 |
| `MAX_UPLOAD_MB` | `2048` | 单个视频上传大小上限（MB） |
| `MAX_SRT_KB` | `10240` | 单个 SRT 导入文件大小上限（KB，默认 10 MB，仅内存解析） |

Compose 中改宿主机端口示例（宿主 9000 → 容器 8080）：

```yaml
    ports:
      - "9000:8080"
```

## 使用流程

1. 打开首页，填写标题并选择视频文件上传（需浏览器可解析的 MP4/WebM 等格式）。
2. 进入工作台：播放视频或点击时间轴定位，用「＋ 新增片段」并可一键取播放位置为起止时间。
3. 在片段表中编辑、删除、定位；逐条「标记已审」。绿色=已审，蓝色=待审。
   长字幕可点「拆分」：在严格位于起止之间的整数毫秒切点处一分为二，填写左右两段原文
   （启用译文轨道时还需按左右原文分别填写两段新译文，不能丢弃或复制原译文）；
   左段保留原片段 ID（修订号 +1），右段获新 ID，两段均转待审，既有质检放行失效（历史理由保留）。
   需要整体校准时间时，勾选若干片段（表头复选框可全选）后点「⇄ 整体平移…」：
   填写非零整数毫秒偏移（正数延后、负数提前）并「预览平移」，逐段核对调整前后时间、越界与未选片段冲突，
   确认无误后「确认一次性应用」；所选片段相对间距不变、修订号逐段 +1 并撤销原文审校，其译文会标记「已失效」需重新校对。
5. 需要套用现成字幕时，点片段列表右上角「⬆ 导入 SRT…」：选择本地 `.srt` 后「解析并预览」，
   核对每条的 SRT 序号、原文件行号、时间与多行文本，以及与当前草稿的冲突；
   无冲突可「追加到草稿」，或随时「替换整个草稿」（已发布版本不受影响）。
   若预览期间草稿被他人改动，确认时会被拒绝并自动按最新草稿重新预览。
6. 需要把某段字幕回退到历史版本时，点「↩ 区间恢复…」：选择已发布版本并填写整数毫秒区间，
   「预览恢复」后并列核对区间内发布快照与当前草稿、以及将移除/恢复的清单，再「确认恢复」；
   恢复片段为待审，需重新审校后才能再次发布。
7. 需要译文时，在右侧「发布与下载」面板输入语言（如 `en`）启用译文轨道：片段表随即出现译文列，
   逐段「录译文/改译文」并按当前原文审校；原文被改动后对应译文显示「已失效」，重新保存译文即完成重新校对。
8. 右侧「发布与下载」面板实时列出阻塞发布的问题（含译文缺失/待审/已失效）；全部满足后点「发布新版本」，
   启用轨道时发布会同时固定原文与译文两轨快照。
9. 需要质检限速时，在右侧「质检规则与放行」面板为原文/译文分别填写「最大每秒字符数」「最大单行字符数」
   （留空不检查；保存需携带规则修订号，阈值变化会使既有放行失效但保留历史）。面板逐段列出违规项，
   点击时间定位到片段；对单项违规点「填写理由放行」（原文放行带原文修订号，译文放行带原文+译文双修订号）。
   发布时服务端会重新质检，未放行违规阻止发布；发布成功后可在历史版本处「查看质检快照」核对当时固定的规则、结果与放行。
10. 用「下载 SRT ▾」选择原文或译文的草稿/任一已发布版本导出（译文导出要求该范围译文齐备且未失效）。
11. 需要区分说话人时，在右侧「说话人名单」卡片「新增说话人」（如主持人、嘉宾A），再在片段表「说话人」列下拉里
    逐段归属；归属成功会让该段原文转**待审**（文字、时间与译文不变，需重新审校）。被片段引用的说话人不能删除，
    须先改这些片段的归属。存在说话人后，未归属片段会阻止发布；发布固定当时名称与逐段归属，之后改名或改草稿不影响历史版本。

## HTTP API 摘要

所有写操作的 JSON 请求体均需携带整数修订号 `revision`（新增片段除外；区间恢复确认、多片段整体平移确认改持预览令牌 `token`；
译文写操作需同时携带所见原文修订号 `segment_revision`，首次录入译文无需译文 `revision`；片段拆分在已有译文时还须携带
所见译文修订号 `translation_revision`）。
质检规则修改携带所见规则修订号 `rules_revision`（首次配置传 `0`）；质检放行携带 `segment_revision`，
译文放行还需译文 `revision`；**说话人名单增删改携带所见名单修订号 `list_revision`（首次传 `0`），片段归属修改携带
所见片段修订号 `revision`**；过期一律 `409 revision_conflict` 并返回当前状态。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/videos` | multipart 上传：`title`、`duration_ms`、`video` |
| `GET` | `/api/videos` / `/api/videos/:id` | 列表 / 详情（含片段与发布版本） |
| `DELETE` | `/api/videos/:id` | 删除视频及其全部数据 |
| `GET` | `/api/videos/:id/media` | 视频流（支持 `Range`） |
| `POST` | `/api/videos/:id/segments` | 新增片段 `{start_ms,end_ms,text}` |
| `PUT` | `/api/videos/:id/segments/:sid` | 修改 `{start_ms,end_ms,text,revision}` |
| `POST` | `/api/videos/:id/segments/:sid/split` | 拆分片段 `{cut_ms,left_text,right_text,revision[,left_translation,right_translation,translation_revision]}`，原子拆为左右两段 |
| `DELETE` | `/api/videos/:id/segments/:sid` | 删除（JSON 体带 `revision`） |
| `POST` | `/api/videos/:id/segments/:sid/review` | 审校切换 `{reviewed,revision}` |
| `GET` | `/api/videos/:id/speakers` | 说话人名单（含每个说话人 `usage_count`）与未归属片段 `unassigned_segment_ids`、`list_revision` |
| `POST` | `/api/videos/:id/speakers` | 新增说话人 `{name,list_revision}`（名称 trim 后非空、不换行、同视频唯一） |
| `PUT` | `/api/videos/:id/speakers/:spid` | 改名 `{name,list_revision}`（历史发布快照不变） |
| `DELETE` | `/api/videos/:id/speakers/:spid` | 删除说话人（JSON 体带 `list_revision`）；仍被片段引用时 `422 speaker_in_use` |
| `PUT` | `/api/videos/:id/segments/:sid/speaker` | 修改片段归属 `{speaker_id,revision}`（`speaker_id` 为 `null` 表示未归属）；片段修订号 +1、转待审，文字/时间/译文不变 |
| `GET` | `/api/videos/:id/publications/:version/speakers` | 查询某发布版本固定的说话人名单与逐段归属（旧版本无快照时 `422 speakers_unavailable`） |
| `GET` | `/api/videos/:id/status` | 发布门禁检查 |
| `POST` | `/api/videos/:id/publish` | 发布不可变版本 |
| `GET` | `/api/videos/:id/publications` | 已发布版本列表 |
| `POST` | `/api/videos/:id/srt/preview` | 预览 SRT 导入（multipart 字段 `srt`，或 JSON `{content}`），返回条目/行号/草稿冲突与确认令牌 `token` |
| `POST` | `/api/videos/:id/srt/import` | 确认写入：multipart 或 JSON 携带 `srt`/`content`、`mode=append\|replace`、预览返回的 `token` |
| `POST` | `/api/videos/:id/restore/preview` | 预览区间恢复 `{version,start_ms,end_ms}`，返回两侧片段清单（`to_restore`/`to_remove`）与确认令牌 `token` |
| `POST` | `/api/videos/:id/restore/confirm` | 确认区间恢复 `{version,start_ms,end_ms,token}`，事务内整批替换 |
| `POST` | `/api/videos/:id/segments/shift/preview` | 预览多片段整体平移 `{segment_ids,offset_ms}`，返回逐段调整前后时间、`boundary_issues`/`conflicts`、`blocked` 与确认令牌 `token` |
| `POST` | `/api/videos/:id/segments/shift/confirm` | 确认整体平移 `{segment_ids,offset_ms,token}`，事务内一次性应用；仅移动所选片段并逐段修订号 +1、撤销原文审校 |
| `GET` | `/api/videos/:id/srt?version=` | 导出原文 SRT：`draft`（默认）/ `published` / `1` 等版本号 |
| `PUT` | `/api/videos/:id/translation/track` | 启用译文轨道 `{language}`（同一视频仅一个语言；同语言重复调用幂等） |
| `DELETE` | `/api/videos/:id/translation/track` | 停用译文轨道并删除草稿全部译文（已发布快照不受影响） |
| `PUT` | `/api/videos/:id/segments/:sid/translation` | 录入/修改译文 `{text,segment_revision,revision?（已有译文时必填）}`；修改撤销译文审校 |
| `POST` | `/api/videos/:id/segments/:sid/translation/review` | 译文审校切换 `{reviewed,segment_revision,revision}`；已失效译文拒绝审校 |
| `GET` | `/api/videos/:id/srt/translation?version=` | 导出译文 SRT：`draft`（默认，需齐备且未失效）/ `published` / 版本号（需该版本含译文快照） |
| `GET` | `/api/videos/:id/qc` | 当前草稿质检结果：逐段轨道/实测值/阈值/违规项 + 全部放行（含失效历史） |
| `PUT` | `/api/videos/:id/qc/rules` | 配置/修改质检阈值（乐观锁 `rules_revision`，首次传 `0`；字段可 `null` 清除） |
| `PUT` | `/api/videos/:id/segments/:sid/qc/waiver` | 对单项违规填写理由放行 `{track,rule,reason,segment_revision,revision?}` |
| `GET` | `/api/videos/:id/publications/:version/qc` | 查询某发布版本固定的质检规则、质检结果与有效放行 |

错误响应统一为 `{ "error": { "code", "message", "current?" } }`：
`422` 为非法修改（含原因），`409` 为修订冲突（`current` 为最新片段）。

### SRT 导入调用示例（两步：预览 → 确认）

SRT 必须原样提交两次（multipart 文件字段 `srt`，或 JSON 字符串字段 `content`；UTF-8，可含 BOM），
服务端用 HMAC 令牌把「所见 SRT 内容 + 草稿指纹」绑定到确认请求；令牌随服务进程重启失效。

第一步——预览（不写入）：

```bash
# multipart
curl -s -X POST http://localhost:8080/api/videos/12/srt/preview \
  -F "srt=@subtitles.srt;type=application/x-subrip"
```

```bash
# 或 JSON
curl -s -X POST http://localhost:8080/api/videos/12/srt/preview \
  -H 'Content-Type: application/json' \
  --data-binary @<(jq -Rs '{content: .}' subtitles.srt)
```

成功返回（节选）：

```json
{
  "draft_count": 2,
  "imported_count": 3,
  "entries": [
    { "entry": 1, "seq": 1, "line": 1, "time_line": 2,
      "start_ms": 1000, "end_ms": 2000, "text": "第一句" }
  ],
  "conflicts": [
    { "entry": 1, "seq": 1, "line": 1, "segment_id": 7,
      "start_ms": 1500, "end_ms": 2500,
      "message": "导入条目「序号 1」（原文件第 1 行）（1000–2000ms）与现有草稿片段 #7（1500–2500ms）时间冲突" }
  ],
  "append_blocked": true,
  "token": "eyJ2IjoxMiwibSI6InByZXZpZXci…….签名"
}
```

解析/时间不合法时返回 `422 invalid_srt`，`errors[]` 逐条给出 `code / entry / seq / line / message`
（错误码：`empty_srt / bad_index / missing_timestamp / bad_timestamp / bad_time_component /
unexpected_line / negative_time / reversed_time / beyond_duration / imported_overlap / text_too_long / draft_conflict`）。

第二步——确认（同一份 SRT + `mode` + 预览 `token`）：

```bash
# 追加（仅当无草稿冲突时成功）
curl -s -X POST http://127.0.0.1:8080/api/videos/12/srt/import \
  -F "srt=@subtitles.srt;type=application/x-subrip" \
  -F "mode=append" \
  -F "token=eyJ2IjoxMiwibSI6InByZXZpZXci…….签名"

# 替换整个草稿（仅影响草稿；已发布版本不变；导入片段均为待审）
curl -s -X POST http://127.0.0.1:8080/api/videos/12/srt/import \
  -F "srt=@subtitles.srt;type=application/x-subrip" \
  -F "mode=replace" \
  -F "token=eyJ2IjoxMiwibSI6InByZXZpZXci…….签名"
```

返回 `201 { ok, mode, imported_count, segments }`。失败约定：

| 状态 / code | 含义 |
| --- | --- |
| `422 invalid_srt` | 解析或时间校验失败（含每条行号），事务未写入 |
| `422 srt_changed` | 确认时的 SRT 内容与预览不一致，需重新预览 |
| `422 invalid_mode` | `mode` 不是 `append` / `replace` |
| `409 preview_required` | 缺失/伪造/过期（服务重启）令牌，需先预览 |
| `409 draft_changed` | 预览后草稿被修改；响应附 `current_segments`，必须重新预览后再确认 |

### 区间恢复调用示例（两步：预览 → 确认）

把已发布版本 `v1` 在 2000–5000ms 区间内的片段整体恢复到草稿。版本与区间随确认请求原样提交，
服务端用 HMAC 令牌把「版本 + 区间 + 草稿指纹」绑定到确认请求；令牌随服务进程重启失效。

第一步——预览（不写入），并列返回发布快照与当前草稿在区间内的片段（即确认后将恢复/将移除的清单）：

```bash
curl -s -X POST http://localhost:8080/api/videos/12/restore/preview \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"start_ms":2000,"end_ms":5000}'
```

成功返回（节选）：

```json
{
  "version": 1,
  "start_ms": 2000,
  "end_ms": 5000,
  "duration_ms": 60000,
  "to_restore": [ { "snapshot_index": 2, "start_ms": 3000, "end_ms": 4000, "text": "历史第二句" } ],
  "to_remove":  [ { "id": 7, "start_ms": 3000, "end_ms": 4000, "text": "草稿第二句(改)",
                    "reviewed": false, "revision": 3 } ],
  "token": "eyJ2IjoxMiwibSI6InJlc3RvcmUi…….签名"
}
```

区间边界穿过任一侧片段时返回 `422 range_crosses_segment`，`crossings[]` 逐条指出片段与时间：

```json
{
  "error": {
    "code": "range_crosses_segment",
    "message": "区间边界穿过 2 个片段，请把起点/终点调整到片段间隙（端点相接允许）：\n区间终点 3500ms 穿过当前草稿片段 #7（3000–4000ms）",
    "crossings": [
      { "side": "draft", "boundary": "end", "at": 3500, "segment_id": 7, "start_ms": 3000, "end_ms": 4000, "message": "区间终点 3500ms 穿过当前草稿片段 #7（3000–4000ms）" },
      { "side": "published", "boundary": "end", "at": 3500, "snapshot_index": 2, "start_ms": 3000, "end_ms": 4000, "message": "区间终点 3500ms 穿过发布快照第 2 条（3000–4000ms）" }
    ]
  }
}
```

第二步——确认（与预览完全相同的 `version`/`start_ms`/`end_ms` + 预览 `token`）：

```bash
curl -s -X POST http://localhost:8080/api/videos/12/restore/confirm \
  -H 'Content-Type: application/json' \
  -d '{"version":1,"start_ms":2000,"end_ms":5000,"token":"eyJ2IjoxMiwibSI6InJlc3RvcmUi…….签名"}'
```

返回 `201 { ok, version, start_ms, end_ms, removed_count, restored_count, removed, restored, segments }`：
区间内草稿片段被移除，历史片段作为**待审**新片段写入（新 id、修订号从 1 开始）；
区间外草稿片段及其修订号、历史发布版本与 SRT 导出均不变。失败约定：

| 状态 / code | 含义 |
| --- | --- |
| `422 invalid_version` / `422 invalid_range` | 版本号非法；区间非整数、起点不早于终点、为负或越过视频时长 |
| `404 version_not_found` | 指定发布版本不存在，未写入 |
| `422 range_crosses_segment` | 区间边界穿过草稿或发布快照片段（`crossings[]` 逐条指出片段与时间），未写入 |
| `422 invalid_timeline` | 替换后时间线不合法，未写入 |
| `422 restore_params_changed` | 确认的版本或区间与预览不一致，需按预览参数确认或重新预览 |
| `409 preview_required` | 缺失/伪造/过期（服务重启）的恢复预览令牌，需先预览 |
| `409 draft_changed` | 预览后草稿被修改（增删改或审校变化）；响应附 `current_segments`，必须重新预览后再确认 |

### 多片段整体平移调用示例（两步：预览 → 确认）

把所选片段整体加上同一个非零整数毫秒偏移，用于整体校准字幕时间。片段选择（`segment_ids`，正整数数组，顺序无关）
与偏移随确认请求原样提交，服务端用 HMAC 令牌把「选择集合 + 偏移 + 草稿指纹」绑定到确认请求；令牌随服务进程重启失效。

第一步——预览（不写入），逐段返回调整前后时间，并指出越界（`boundary_issues`）与未选片段冲突（`conflicts`）：

```bash
curl -s -X POST http://localhost:8080/api/videos/12/segments/shift/preview \
  -H 'Content-Type: application/json' \
  -d '{"segment_ids":[7,9],"offset_ms":500}'
```

成功返回（节选；即使 `blocked=true` 也返回 200，供工作台展示问题；此时确认会被拒）：

```json
{
  "offset_ms": 500,
  "duration_ms": 60000,
  "selected_count": 2,
  "unselected_count": 3,
  "moved": [
    { "segment_id": 7, "text": "第一句", "reviewed": true, "revision": 3,
      "before_start_ms": 1000, "before_end_ms": 2000, "after_start_ms": 1500, "after_end_ms": 2500 },
    { "segment_id": 9, "text": "第三句", "reviewed": false, "revision": 1,
      "before_start_ms": 5000, "before_end_ms": 6000, "after_start_ms": 5500, "after_end_ms": 6500 }
  ],
  "boundary_issues": [],
  "conflicts": [
    { "segment_id": 9, "other_segment_id": 8,
      "after_start_ms": 5500, "after_end_ms": 6500, "other_start_ms": 6200, "other_end_ms": 7000,
      "message": "所选片段 #9 平移后（5500–6500ms）与未选片段 #8（6200–7000ms）时间重叠（端点相接允许）" }
  ],
  "blocked": true,
  "token": "eyJ2IjoxMiwibSI6InNoaWZ0Iiwi…….签名"
}
```

第二步——确认（与预览相同的选择集合与偏移 + 预览 `token`，顺序可不同）：

```bash
curl -s -X POST http://localhost:8080/api/videos/12/segments/shift/confirm \
  -H 'Content-Type: application/json' \
  -d '{"segment_ids":[9,7],"offset_ms":500,"token":"eyJ2IjoxMiwibSI6InNoaWZ0Iiwi…….签名"}'
```

返回 `201 { ok, offset_ms, moved_count, moved, segments, translations }`：仅所选原文片段被移动，
修订号逐段 +1、审校被撤销；其译文保留文字但在 `translations[].stale` 中标记为 `true`，须按新时间重新校对。
失败约定：

| 状态 / code | 含义 |
| --- | --- |
| `422 invalid_segment_ids` | `segment_ids` 缺失、为空或不是正整数数组，未写入 |
| `422 duplicate_segment_ids` | 片段 ID 重复（`error.duplicate_ids` 指出），未写入 |
| `422 unknown_segments` | 部分 ID 不属于该视频（`error.missing_ids` 指出），未写入 |
| `422 invalid_offset` | 偏移缺失、非整数或为 0，未写入 |
| `422 shift_blocked` | 存在越界或未选片段重叠（`error.boundary_issues`/`error.conflicts` 逐条指出），事务未写入 |
| `422 shift_params_changed` | 确认的选择集合或偏移与预览不一致，需重新预览 |
| `409 preview_required` | 缺失/伪造/过期（服务重启）的平移预览令牌，需先预览 |
| `409 draft_changed` | 预览后草稿被修改（增删改或审校变化）；响应附 `current_segments`，必须重新预览后再确认 |

### 片段拆分调用示例（一步原子完成）

把片段 #7（1000–3000ms，所见修订号 3）在 1800ms 处拆成左右两段：左段保留 ID #7（修订号 +1），
右段获新 ID（修订号从 1 开始）；两段均转待审，既有质检放行失效（历史理由保留），
历史发布版本及其 SRT 不变，草稿、发布门禁与导出立即反映拆分结果。

```bash
V=12

# 未启用译文轨道：提交切点 + 左右两段非空原文 + 所见修订号
curl -s -X POST http://localhost:8080/api/videos/$V/segments/7/split \
  -H 'Content-Type: application/json' \
  -d '{"cut_ms":1800,"left_text":"前半句","right_text":"后半句","revision":3}'
```

成功返回 `201`（节选）：

```json
{
  "ok": true,
  "cut_ms": 1800,
  "left":  { "id": 7, "start_ms": 1000, "end_ms": 1800, "text": "前半句", "reviewed": false, "revision": 4 },
  "right": { "id": 9, "start_ms": 1800, "end_ms": 3000, "text": "后半句", "reviewed": false, "revision": 1 },
  "segments": [ /* 拆分后的完整草稿片段列表 */ ],
  "translations": []
}
```

启用译文轨道时，须同时提交左右两段**非空译文**；该片段已有译文时还须携带所见译文修订号
`translation_revision`。左右译文均不得与原译文完全相同（不能丢弃或复制原译文，须重新翻译）；
拆分后左段译文在原译文行上更新（修订号 +1），右段译文新建，两段译文均待审且绑定各自新原文：

```bash
curl -s -X POST http://localhost:8080/api/videos/$V/segments/7/split \
  -H 'Content-Type: application/json' \
  -d '{"cut_ms":1800,"left_text":"前半句","right_text":"后半句","revision":3,
       "left_translation":"First half","right_translation":"second half","translation_revision":2}'
```

失败约定（均零写入，草稿保持原样）：

| 状态 / code | 含义 |
| --- | --- |
| `404 segment_not_found` | 片段不存在 |
| `422 missing_revision` | 缺少所见原文修订号 `revision`；或该片段已有译文却缺少 `translation_revision` |
| `409 revision_conflict` | 原文或译文修订号过期；`error.current` 为当前 `{segment, translation}` 状态 |
| `422 invalid_cut_point` | 切点缺失、非整数，或未严格位于片段起止之间（时长 1ms 的片段无合法整数切点） |
| `422 empty_text` | 左/右段原文为空（去首尾空白后至少 1 个字符） |
| `422 missing_translation` | 已启用译文轨道但缺少左/右译文，或译文为空白 |
| `422 copied_translation` | 左/右译文与原译文完全相同，须按拆分后的原文重新翻译 |
| `422 invalid_timeline` | 拆分后时间线不合法（防御性复算），未写入 |

### 译文轨道调用示例

同一视频仅可启用**一个**指定语言的译文轨道；译文逐段关联当前草稿原文片段。
所有译文写操作都要携带**两个修订号**：所见原文修订号 `segment_revision` 与所见译文修订号 `revision`
（首次录入时译文尚不存在，只需 `segment_revision`）；过期返回 `409` 与当前原文/译文状态。

```bash
V=12  # 视频 id

# 1) 启用译文轨道（换语言须先 DELETE 停用，停用会删除草稿全部译文）
curl -s -X PUT http://localhost:8080/api/videos/$V/translation/track \
  -H 'Content-Type: application/json' -d '{"language":"en"}'

# 2) 录入片段 #7 的译文（片段当前修订号 3）
curl -s -X PUT http://localhost:8080/api/videos/$V/segments/7/translation \
  -H 'Content-Type: application/json' -d '{"text":"Hello world","segment_revision":3}'

# 3) 修改译文（译文修订号 1；修改会撤销译文审校状态）
curl -s -X PUT http://localhost:8080/api/videos/$V/segments/7/translation \
  -H 'Content-Type: application/json' -d '{"text":"Hello, world!","segment_revision":3,"revision":1}'

# 4) 审校译文（双修订号；原文若已变更导致译文失效，会被 422 拒绝，需先重新保存译文）
curl -s -X POST http://localhost:8080/api/videos/$V/segments/7/translation/review \
  -H 'Content-Type: application/json' -d '{"reviewed":true,"segment_revision":3,"revision":2}'

# 5) 查看双轨门禁状态（translation 汇总 + pending 待处理片段）
curl -s http://localhost:8080/api/videos/$V/status

# 6) 发布（启用轨道后要求每段原文已审、译文已审且未失效；失败 422 附 pending，不生成部分版本）
curl -s -X POST http://localhost:8080/api/videos/$V/publish

# 7) 导出译文 SRT（草稿需译文齐备且未失效；发布版本需含译文快照）
curl -s -OJ "http://localhost:8080/api/videos/$V/srt/translation?version=draft"
curl -s -OJ "http://localhost:8080/api/videos/$V/srt/translation?version=1"
```

译文失效规则：原文的**文字或时间**被修改后，对应译文 `stale=true`（仅切换原文审校状态不会）；
删除片段、SRT 整稿替换、区间恢复产生的新片段一律没有译文。重新保存译文（`PUT .../translation`）
即把译文重新绑定到当前原文并清除失效标记，同时撤销其审校状态。

失败约定（在通用错误格式 `{ "error": { "code", "message", ... } }` 之上）：

| 状态 / code | 含义 |
| --- | --- |
| `422 no_translation_track` | 未启用译文轨道却进行译文操作/导出 |
| `422 invalid_language` / `422 track_exists` | 语言非法；已启用其它语言（须先停用） |
| `404 translation_not_found` | 该片段尚无译文（审校前需先录入） |
| `409 revision_conflict` | 原文或译文修订号过期；`error.current` 为当前 `{segment, translation}` 状态 |
| `422 translation_stale` | 译文已失效（原文文字/时间已变），需先重新校对译文 |
| `422 not_publishable` | 发布门禁未过；`error.pending[]` 逐段给出 `segment_id` 与 `reasons`（`segment_unreviewed` / `translation_missing` / `translation_stale` / `translation_unreviewed`），不生成部分版本 |
| `422 translation_incomplete` | 草稿译文缺失或失效，无法导出译文 SRT；`error.pending[]` 逐段指出片段与原因 |
| `422 translation_unavailable` | 指定发布版本不含译文快照（发布时未启用轨道） |

### 质检（QC）调用示例

每个视频可分别为**原文**与**已启用译文**配置 `最大每秒字符数（max_cps）` 与 `最大单行字符数（max_line_chars）`。
字段省略表示不修改，传 `null` 清除该项；阈值必须为正数（单行字符数须为正整数，CPS 可为小数）。
字符按 **Unicode 码点**计数，**换行不计入速度**；速度 = 非换行字符数 ÷ 片段秒数。规则修改用 `rules_revision` 乐观锁（首次传 `0`）。

```bash
V=12

# 1) 首次配置（原文 CPS≤15、单行≤42；译文 CPS≤20、单行≤84）
curl -s -X PUT http://localhost:8080/api/videos/$V/qc/rules \
  -H 'Content-Type: application/json' \
  -d '{"source_max_cps":15,"source_max_line_chars":42,"translation_max_cps":20,"translation_max_line_chars":84,"rules_revision":0}'
# -> { "ok": true, "rules_revision": 1, "rules": { "revision": 1, "source": {...}, "translation": {...} } }

# 2) 只改一项（携带当前修订号 1）；阈值变化会使既有放行整体失效（历史保留）
curl -s -X PUT http://localhost:8080/api/videos/$V/qc/rules \
  -H 'Content-Type: application/json' -d '{"source_max_cps":17,"rules_revision":1}'

# 3) 并发修改拿着过期修订号 -> 409，响应回传当前规则
#    { "error": { "code":"revision_conflict", "current_rules": {...}, "rules_revision": 1 } }

# 4) 查看当前草稿质检（逐段轨道/实测值/阈值/违规项，含全部放行历史）
curl -s http://localhost:8080/api/videos/$V/qc
```

返回（节选）：

```json
{
  "rules": { "revision": 2,
    "source": { "max_cps": 17, "max_line_chars": 42 },
    "translation": { "language": "en", "max_cps": 20, "max_line_chars": 84 } },
  "tracks": ["source", "translation"],
  "configured": true,
  "segments": [
    { "segment_id": 7, "start_ms": 1000, "end_ms": 2000, "duration_ms": 1000,
      "source": { "items": [
        { "rule": "max_cps", "threshold": 17, "value": 20, "chars": 20, "duration_ms": 1000,
          "violation": true, "waived": false, "waiver": null } ] },
      "translation": { "present": true, "stale": false, "language": "en",
        "items": [ /* 译文轨道逐项实测，结构相同 */ ] } }
  ],
  "violations": [
    { "segment_id": 7, "start_ms": 1000, "end_ms": 2000, "duration_ms": 1000,
      "track": "source", "rule": "max_cps", "value": 20, "threshold": 17,
      "waived": false, "waiver": null, "detail": { "chars": 20, "duration_ms": 1000 },
      "language": null,
      "message": "原文片段 #7：每秒字符数 20 超过阈值 17（20 个字符 / 1.000 秒）" }
  ],
  "blocking_violations": [ /* 未放行的违规（=违规中 waived=false 的子集），阻止发布 */ ],
  "waivers": [ /* 全部放行：active=true 有效；active=false 已失效（历史理由保留） */ ],
  "valid_waivers": [ /* 当前仍有效的放行 */ ],
  "violation_count": 1, "blocking_count": 1,
  "active_waiver_count": 0, "inactive_waiver_count": 0, "can_publish": false
}
```

对单项违规填写理由放行。放行绑定放行时的**片段时间、文本、轨道语言与当时阈值（规则修订号）**，
任一变化后失效（不复活），理由永久保留在 `waivers[]` 中（`active=false`）：

```bash
# 原文放行（携带所见原文修订号）
curl -s -X PUT http://localhost:8080/api/videos/$V/segments/7/qc/waiver \
  -H 'Content-Type: application/json' \
  -d '{"track":"source","rule":"max_cps","reason":"片头快语速，已人工逐字校对","segment_revision":3}'

# 译文放行（同时携带原文与译文修订号）
curl -s -X PUT http://localhost:8080/api/videos/$V/segments/7/qc/waiver \
  -H 'Content-Type: application/json' \
  -d '{"track":"translation","rule":"max_line_chars","reason":"英文专有名词较长，人工确认","segment_revision":3,"revision":2}'
# -> 201 { "waiver": { "id": 1, "active": 1, "bound_start_ms": 1000, "bound_end_ms": 2000,
#                      "bound_text": "…", "bound_rules_revision": 2, "bound_thresholds": {...} },
#          "qc": { /* 放行后的最新完整质检报告 */ } }
```

发布时服务端**重新质检**：存在未放行违规时 `422 qc_blocked`，返回 `qc_violations[]` 清单且不产生版本；
成功后可查询版本固定的规则、结果与有效放行：

```bash
curl -s http://localhost:8080/api/videos/$V/publications/3/qc
# -> { "snapshot": true, "version": 3, "rules_snapshot": {...}, "segments": [...],
#       "violations": [...], "valid_waivers": [...] }   # 发布后草稿再变也不影响该快照
# 发布时未配置阈值的旧版本：422 qc_unavailable（旧发布版本与 SRT 导出行为保持不变）
```

质检相关失败约定：

| 状态 / code | 含义 |
| --- | --- |
| `422 invalid_qc_threshold` | 阈值非正数，或单行字符数不是正整数；未写入 |
| `422 invalid_qc_rules` | 规则体为空 / 不含任何已知阈值字段 |
| `422 missing_revision` | 缺少 `rules_revision` / 放行缺少 `segment_revision`（译文放行还需 `revision`） |
| `409 revision_conflict` | 规则修订号、原文或译文修订号过期；`error.current_rules` 或 `error.current` 返回当前状态 |
| `422 invalid_qc_track` / `invalid_qc_rule` | `track` 不是 `source`/`translation`，或 `rule` 不是 `max_cps`/`max_line_chars` |
| `422 invalid_waiver_reason` | 放行理由为空或超过 500 字符 |
| `422 no_such_violation` | 当前该片段该轨道不存在对应违规（阈值未配置或内容已变），无需放行；回传 `current_qc` |
| `422 waiver_exists` | 该违规已有有效放行；回传 `current_qc` 与既有 `waiver` |
| `422 no_translation_track` | 未启用译文轨道却对译文违规放行 |
| `422 qc_blocked` | 发布重新质检发现未放行违规；`error.qc_violations[]` 为完整清单，未生成版本 |
| `422 qc_unavailable` | 指定发布版本不含质检快照（发布时未配置阈值），旧版本行为不变 |

### 说话人名单与片段归属调用示例

每个视频维护独立的说话人名单，并把草稿原文片段逐段归属到一名说话人。名单写操作（增/改/删）携带
**所见名单修订号 `list_revision`**（首次传 `0`）；归属修改携带**所见片段修订号 `revision`**。
归属成功只让片段转待审、修订号 +1，**原文文字与时间、译文都不变**（译文不会因此失效）。

```bash
V=12

# 1) 查看名单（含引用计数）与未归属片段
curl -s http://localhost:8080/api/videos/$V/speakers
# -> { "list_revision": 0, "speakers": [], "unassigned_segment_ids": [7,9] }

# 2) 新增说话人（名称自动 trim；首次传 list_revision=0）
curl -s -X POST http://localhost:8080/api/videos/$V/speakers \
  -H 'Content-Type: application/json' -d '{"name":"  主持人  ","list_revision":0}'
# -> 201 { "speaker": {"id":1,"name":"主持人","usage_count":0},
#          "list_revision":1, "speakers":[...] }

# 3) 再新增一位（携带当前名单修订号 1）
curl -s -X POST http://localhost:8080/api/videos/$V/speakers \
  -H 'Content-Type: application/json' -d '{"name":"嘉宾A","list_revision":1}'

# 4) 把片段 #7 归属给说话人 #1（携带所见片段修订号）
curl -s -X PUT http://localhost:8080/api/videos/$V/segments/7/speaker \
  -H 'Content-Type: application/json' -d '{"speaker_id":1,"revision":3}'
# -> { "changed": true,
#      "segment": {"id":7,"speaker_id":1,"speaker_name":"主持人","reviewed":false,"revision":4},
#      "segments":[...], "unassigned_segment_ids":[9] }
# 原文文字/时间不变；若该段有译文，译文 stale 仍为 false（不因归属失效）

# 5) 置回未归属（speaker_id 传 null）
curl -s -X PUT http://localhost:8080/api/videos/$V/segments/7/speaker \
  -H 'Content-Type: application/json' -d '{"speaker_id":null,"revision":4}'

# 6) 改名（仅影响草稿与今后的发布；历史发布快照不变）
curl -s -X PUT http://localhost:8080/api/videos/$V/speakers/1 \
  -H 'Content-Type: application/json' -d '{"name":"主持人（甲）","list_revision":2}'

# 7) 删除说话人（仍被片段引用时拒绝）
curl -s -X DELETE http://localhost:8080/api/videos/$V/speakers/2 \
  -H 'Content-Type: application/json' -d '{"list_revision":3}'
```

视频存在说话人时，未归属片段会阻止发布；失败响应 `error.pending[]` 逐段给出原因 `speaker_unassigned`：

```json
{
  "error": {
    "code": "not_publishable",
    "message": "当前草稿不能发布：说话人：1 个片段尚未归属说话人",
    "pending": [ { "segment_id": 9, "start_ms": 2000, "end_ms": 3000,
                  "reasons": ["segment_unreviewed", "speaker_unassigned"] } ],
    "speakers": { "enabled": true, "total": 2, "unassigned": 1, "assigned": 1 }
  }
}
```

发布成功后，版本固定当时的名单名称与逐段归属（说话人快照）；之后改名或改草稿归属都不影响历史版本：

```bash
# 发布（所有片段已归属且已审、其余门禁通过）
curl -s -X POST http://localhost:8080/api/videos/$V/publish
# -> { "publication": { "version": 2, "has_speakers": true, ... } }

# 查询 v2 固定的说话人名单与逐段归属
curl -s http://localhost:8080/api/videos/$V/publications/2/speakers
# -> { "snapshot": true, "list_revision": 3,
#      "speakers": [ {"id":1,"name":"主持人"}, {"id":2,"name":"嘉宾A"} ],
#      "assignments": [ {"segment_id":7,"speaker_id":1}, {"segment_id":9,"speaker_id":2} ] }
```

补充不变量：**拆分**片段时左右两段沿用原归属；**SRT 导入**与**历史区间恢复**产生的新片段一律未归属（需重新归属并审校）。
原文/译文 SRT 导出始终不含说话人信息、语义不变；无说话人名单时发布的旧版本无说话人快照（查询返回 `422 speakers_unavailable`）。

失败约定：

| 状态 / code | 含义 |
| --- | --- |
| `422 invalid_speaker_name` | 名称不是字符串、trim 后为空、含换行或超过 100 字符 |
| `422 duplicate_speaker` | 同视频已存在同名说话人（按 trim 后精确比较） |
| `422 missing_revision` | 名单写操作缺少 `list_revision`；归属缺少片段 `revision` |
| `409 revision_conflict` | 名单修订号或片段修订号过期；`error` 带回当前 `speakers/list_revision`（归属时还有 `current.segment`） |
| `404 speaker_not_found` | 改名/删除的说话人不存在（归属到其他视频的说话人同样按不存在处理） |
| `422 speaker_in_use` | 说话人仍被草稿片段引用，禁止删除；`error.usage_count` 与 `error.referenced_by[]` 给出引用片段 |
| `422 missing_speaker` / `invalid_speaker` | 归属请求缺少 `speaker_id`，或其值既不是正整数也不是 `null` |
| `422 speaker_unassigned`（在 `pending[].reasons` 中） | 有说话人时该片段尚未归属，阻止发布 |
| `422 speakers_unavailable` | 指定发布版本不含说话人快照（发布时无说话人名单），旧版本行为不变 |

## 数据布局```
data/
├── app.db            # SQLite：videos / segments / speakers / translations / qc_rules / qc_waivers / publications / schema_migrations
└── videos/           # 上传的原始视频文件（随机化文件名）
```

### 数据库结构版本化升级

启动时按版本号顺序执行结构迁移（`src/db.js` 中的 `MIGRATIONS` 定义），每个迁移的
版本号、名称与登记时间写入 `schema_migrations` 表，可随时核查升级历史：

- **新建空库**：依次执行全部迁移后达到当前结构；
- **既有应用数据库**：首次升级时逐个识别其已有结构并登记（不重建数据库，不丢失视频、
  字幕、译文、质检与发布快照数据），仅补全缺失的表、列与索引；
- **原子性**：每个迁移的结构变更与版本登记在同一事务内提交，任一失败即整体回滚该版本；
- **多进程并发**：迁移在 `BEGIN IMMEDIATE` 写锁事务内执行并二次核查登记，
  多个服务进程同时启动时同一迁移只生效一次；
- **失败保护**：任一迁移失败时服务中止启动（非零退出），不会以未完成升级的数据库提供请求；
  修复后重新启动即可从断点继续升级。

> 说明：本应用面向可信的本机/小团队内网环境，未内置账号鉴权；如需公网暴露，请自行置于
> 反向代理与访问控制之后，并建议把 `HOST` 绑定到内部地址。
