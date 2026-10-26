# 工作台 · 技术架构

> 对应文档：[PRD-工作台.html](./PRD-工作台.html)（v2.4）
> 状态：评审稿 v2（`backend` + `web` 双工作区，预留服务化）｜ 2026-10-25

## 1. 技术选型

| 层 | 选型 | 版本基线 | 说明 |
| --- | --- | --- | --- |
| 桌面外壳 | **Tauri 2**（`backend/desktop`） | 2.x | 进程内 Rust 后端 + 系统 WebView（Windows 用 WebView2），安装包小、内存占用低 |
| 前端框架 | **React + TypeScript** | React 18 / TS 5 | 生态与组件最全，适合长时间迭代 |
| 构建 | **Vite + pnpm workspace** | 5+ / 9+ | `web` 与 `backend` 双工作区；`beforeDevCommand: pnpm -C web dev` |
| 画布 | **React Flow（@xyflow/react）** | 12.x | 节点、贝塞尔连线、缩放平移、自定义节点开箱即用 |
| 状态 | **Zustand + Immer** | 5.x / 10.x | 画布选中、筛选、面板状态轻量可控 |
| Markdown 解析 | **micromark + mdast-util-gfm-table** | 最新 | 保留原始单元格，21 字段解析与「原表模式」共用一套 AST |
| frontmatter | **js-yaml + 自定义分隔器** | 最新 | 不用 gray-matter，避免浏览器 Buffer polyfill |
| Schema 校验 | **Zod** | 3.x | 21 字段、批次、资产清单、提示词元数据统一建模 |
| 后端索引 | **SQLite（rusqlite，bundled）** | 0.3x | 位于 `backend/core`，不依赖 Tauri；支持 FTS5；索引可重建 |
| 文件监听 | **notify** | 6.x | `backend/core/watch.rs`：去抖 + 稳定窗口，产出领域事件 |
| 文件读取 | **`backend/core` 受限读取** | — | 前端不直接碰文件系统；路径一律「相对项目根」，由 core 做越界校验 |
| 原生对话框 | **tauri-plugin-dialog** | 官方插件 | 选项目根、导出另存（仅 desktop） |
| 后端服务（预留） | **axum + SSE** | 0.7 | M7 启用，复用 `backend/core`；路由与 IPC 命令一一对应 |
| 剪贴板 | **tauri-plugin-clipboard-manager** | 官方插件 | 复制提示词，避免 WebView 安全上下文差异 |
| 本地偏好 | **tauri-plugin-store** | 官方插件 | 窗口状态、上次项目、面板宽度 |
| 测试 | **Vitest + cargo test + WebdriverIO（tauri-driver）** | 最新 | domain 用 Vitest；core 用 cargo test；桌面 E2E 用 tauri-driver |

### 明确不选

- **Electron**：能跑，但安装包与内存成本高；本项目不需要 Chromium 一致性。
- **Vue + Vue Flow**：能力等价，但团队/生态默认 React，减少切换成本。
- **把解析放进 Rust**：Markdown 脏数据规则会高频调整，放在 TS 层迭代更快；`backend/core` 只做 IO、监听、索引与存储，不做 21 字段解析。
- **IndexedDB / localStorage 存业务数据**：不可重建、不可查询，且与「项目目录是唯一真相」冲突。
- **M0 就起 HTTP 服务**：单机单用户没有第二个客户端，先加端口、守护进程、鉴权是纯负担；结构上预留，时机到了再开。

## 2. 架构原则

1. **项目目录是唯一真相**：`分镜.md`、`video/*.md`、`资产/assets.json` 只读；软件不写回。
2. **索引可丢弃**：删除 SQLite 后能从项目目录完整重建；派生表可清空，用户数据表（便签、人工意见、画布布局）必须保留。
3. **解析与渲染分离**：文件 → 领域模型 → 画布节点；解析失败不阻断渲染，退回「原表模式」。
4. **单向依赖**：`features → domain → platform → transport → backend`。`platform` 是 web 侧唯一能触达后端的层；`domain`、`features` 不得出现 Tauri 或 HTTP 细节。
5. **画布是视图，不是数据源**：节点与连线由索引派生；拖拽位置只存布局表，不影响镜号、时长与提示词。
6. **写操作白名单**：只允许写「便签、人工意见、审阅状态、画布布局、导出文件」。其余一律只读。
7. **后端可服务化**：今日后端是 `backend/desktop`（进程内 Tauri），未来可加 `backend/server`（HTTP/SSE）。两者共用 `backend/core`，前端只换 `transport` 实现。

## 3. 目录结构与分层

Monorepo：顶层两个应用 `web/` 与 `backend/`，根目录只放工作区配置与文档。

```text
AssetsManage/
├─ package.json                pnpm workspace 根：脚本与共享 devDeps
├─ pnpm-workspace.yaml
├─ tsconfig.base.json
├─ ARCHITECTURE.md
├─ PRD-工作台.html
│
├─ web/                        UI（桌面与未来浏览器共用同一份构建）
│  ├─ package.json
│  ├─ index.html
│  ├─ vite.config.ts           base:'./'；产物 web/dist
│  ├─ tsconfig.json
│  ├─ src/
│  │  ├─ main.tsx
│  │  ├─ app/                  单页外壳：顶栏 / 画布 / 预览；启动序列；快捷键；错误边界
│  │  ├─ features/             canvas / preview / timeline / assets / review / sticky
│  │  ├─ domain/               model / parse / validate / graph / select / export
│  │  ├─ platform/
│  │  │  ├─ transport/
│  │  │  │  ├─ contract.ts     ★ BackendClient 接口 + 事件类型（唯一后端契约）
│  │  │  │  ├─ ipc.ts          ★ 当前：Tauri invoke / listen
│  │  │  │  ├─ http.ts         ★ 预留：fetch + SSE（M7）
│  │  │  │  └─ index.ts        createBackend()：按 runMode 选实现
│  │  │  ├─ runMode.ts         'desktop' | 'web'
│  │  │  ├─ repository.ts      实体读写（便签/意见/布局/索引）——上层唯一入口
│  │  │  ├─ watch.ts           订阅 project:changed → 二次合并 → 广播 patch
│  │  │  ├─ clipboard.ts       桌面走插件；web 走 navigator.clipboard
│  │  │  ├─ dialog.ts          open/save；web 降级为 <input type=file> + 下载
│  │  │  ├─ image.ts           asset URL 适配（convertFileSrc / http URL）
│  │  │  └─ prefs.ts           窗口状态、上次项目、面板宽度
│  │  ├─ store/                Zustand stores
│  │  └─ styles/               设计 token 与全局样式
│  └─ tests/                   unit（Vitest）、e2e（tauri-driver）
│
├─ backend/                    Cargo workspace
│  ├─ Cargo.toml               members = ["core", "desktop"]
│  ├─ core/                    ★ 纯逻辑库：不依赖 tauri，不依赖 axum
│  │  └─ src/
│  │     ├─ lib.rs
│  │     ├─ project.rs          项目根、目录约定、相对路径解析
│  │     ├─ scan.rs             文件清单（path / mtime / size）
│  │     ├─ fsio.rs             受限读取、批量读文本、stat、越界校验
│  │     ├─ watch.rs            notify + 300ms 去抖 + 稳定窗口
│  │     ├─ index/              SQLite 派生表：schema.sql、upsert、rebuild
│  │     ├─ storage/            用户表（便签 / 意见 / 布局）+ 迁移
│  │     ├─ search.rs           FTS5 查询，不可用时回退 LIKE
│  │     ├─ events.rs           领域事件枚举（与传输无关）
│  │     └─ error.rs            CoreError → 稳定错误码
│  ├─ desktop/                 当前唯一可执行外壳（Tauri 2）
│  │  ├─ Cargo.toml
│  │  ├─ build.rs
│  │  ├─ tauri.conf.json        frontendDist: ../../web/dist
│  │  ├─ capabilities/default.json
│  │  └─ src/
│  │     ├─ main.rs
│  │     ├─ lib.rs              插件注册、命令注册、窗口、关闭前 flush
│  │     ├─ bridge.rs           core::Event → Tauri emit（唯一 emit 点）
│  │     └─ commands/           project / files / watch / entities / system
│  └─ server/                   ★ 预留：未来 HTTP/SSE 服务（M7 才创建）
│
├─ shared/                      ★ 预留：跨语言契约
│  └─ contracts/                commands.json、events.json（JSON Schema）
│
├─ fixtures/                    真实 Agent 产出的示例项目（脱敏）
└─ scripts/                     dev / build / package
```

### 3.1 三段缝

结构上只有三个允许变化的接缝，每个接缝只建一个方向的依赖：

| 缝 | 位置 | 规则 |
| --- | --- | --- |
| 传输缝 | `web/src/platform/transport/` | 上层只认 `contract.ts`；`ipc.ts` 与 `http.ts` 可整体替换 |
| 核心缝 | `backend/core/` | 不 import `tauri::*`、不 import `axum::*`；只吃「项目根 + db_path」两个入参 |
| 契约缝 | `shared/contracts/` | 命令名、入参、事件载荷的语言中立描述，供 Rust 与 TS 双向对齐 |

```text
web/features → web/domain → web/platform → transport → [ipc | http] → backend
backend/desktop → backend/core        （单向）
backend/server  → backend/core        （M7，单向）
```

### 3.2 为什么解析留在 web

`backend/core` 只做「搬字节」：扫描、读取、监听、索引、存储。21 字段解析、批次回退、槽位判定、脏数据兜底全部在 `web/src/domain`。

三个理由：

1. 分镜规则会随 Agent 的输出习惯高频调整，TS 迭代比 Rust 重新编译快一个数量级。
2. `domain` 是纯函数，Vitest 用真实产出做 fixtures 就能覆盖，不需要起进程。
3. 未来若加 `backend/server`，服务端只把「原始文件 + 事件」送出去，规则仍然只有一份，不会出现 Rust 与 TS 两套解析互相对不上的局面。

> 反例：如果把解析下沉到 core，服务端和前端各自需要一份结果，字段一改就要两边同步，必然漂移。

### 3.3 前端只认一个接口

```ts
// web/src/platform/transport/contract.ts
export interface BackendClient {
  scanProject(root: string): Promise<{ files: FileEntry[]; warnings: string[] }>;
  readTextBatch(root: string, paths: string[]): Promise<Record<string, TextFile>>;
  statPaths(root: string, paths: string[]): Promise<Record<string, StatInfo>>;
  assetUrl(root: string, path: string): Promise<string>;

  watchStart(root: string): Promise<void>;
  watchStop(): Promise<void>;
  onProjectChanged(cb: (e: ProjectChanged) => void): () => void;

  entityPut(table: EntityTable, rows: unknown[]): Promise<void>;
  entityList(table: EntityTable, filter: unknown): Promise<unknown[]>;
  searchPrompts(q: string, limit: number): Promise<SearchHit[]>;

  saveText(name: string, content: string): Promise<string | null>;
  openInFolder(root: string, path: string): Promise<void>;
}
```

三条硬约束，保证 `ipc.ts → http.ts` 是机械替换而不是重写：

1. 方法只接受「相对项目根的路径」与可 JSON 序列化的结构，不出现 `FileHandle`、`Blob`、流对象等传输私有类型。
2. 后端只返回原始资源与实体，**不返回已组装好的领域对象**；领域模型由 `domain/parse` 在 web 侧构建。
3. 事件统一为 `ProjectChanged`，桌面用 `emit`、服务端用 SSE，载荷是同一个 JSON。

### 3.4 依赖约束用工具锁死

- ESLint `no-restricted-imports`：`features/**`、`domain/**` 禁止 import `@tauri-apps/*`，禁止 import `platform/transport/ipc`。
- CI 断言 `cargo tree -p core` 输出中不含 `tauri` / `axum`，防止 core 被意外污染。
- 仅 `platform/transport/*` 与 `platform/clipboard.ts`、`platform/prefs.ts` 可以 import `@tauri-apps/*`。

## 4. 数据流

### 4.1 导入

```text
选择项目根目录（desktop：dialog 插件 / web：输入或拖入）
  → transport.scanProject(root)：backend/core 扫出文件清单（path / mtime / size）
  → transport.readTextBatch(root, paths)：批量取文本
  → domain/parse：分镜.md / 分镜.json / 分镜.meta.json / video/*.md / 资产/assets.json
  → domain/validate：21 字段、镜号、时长、批次、槽位
  → 组装领域模型
  → repository：写入派生表（用户表保留）
  → store 水合 → 画布渲染
```

### 4.2 外部改动

```text
backend/core/watch.rs 捕获 create/modify/delete（去抖 300ms + 稳定窗口）
  → core::Event::ProjectChanged { root, paths, kind }
  → desktop/bridge.rs → emit ｜ server（M7）：SSE
  → platform/watch.ts 收到后二次合并（跨批次去重）
  → 仅重解析受影响文件（scope 判定：整集 / 单镜提示词 / 资源清单）
  → repository 增量 upsert
  → 计算 patch（新增 / 删除 / 改动的镜与槽位）
  → 画布打补丁；被删镜的便签转「未绑定」
```

### 4.3 用户操作

```text
复制提示词      → clipboard.ts（默认纯 prompt 正文）
写便签          → store（即时）→ repository.entityPut（防抖 500ms）
便签转意见      → review store → repository.entityPut
拖动画布节点    → repository 写 canvas_layout（节流 200ms）
导出意见/清单   → domain/export → transport.saveText（desktop 弹保存框 / web 直接下载）
```

### 4.4 两种运行模式

同一份 `web` 构建，靠 `runMode` 决定装配哪个 transport、哪些能力走本地降级：

| 能力 | desktop（`ipc.ts`） | web（`http.ts`，M7） |
| --- | --- | --- |
| 选项目根 | `dialog` 插件 | 服务端托管目录，前端不可选 |
| 读写文件 | `core/fsio` 直读 | 服务端代读 |
| 文件监听 | `notify` → `emit` | 服务端 `notify` → SSE |
| 剪贴板 | `clipboard-manager` 插件 | `navigator.clipboard` |
| 导出文件 | 弹保存框 + 写盘 | 服务端写 `_review/` 或浏览器下载 |
| 图片 | `convertFileSrc`（`asset:`） | `GET /api/assets/{path}` |
| 本地偏好 | `store` 插件 | `localStorage` |

降级能力集中在 `platform/` 四个文件（`clipboard` / `dialog` / `image` / `prefs`），`features` 层感知不到差异。

## 5. 领域模型

| 对象 | 关键字段 | 主键 |
| --- | --- | --- |
| Project | root、name、episodes | root 规范化路径 |
| Episode | no、title、path、targetDur、totalDur | `projectRoot#ep:01` |
| Batch | no、title、from、to、sceneNos | `episodeId#batch:01` |
| Scene | no、name、shotNos | `episodeId#scene:01` |
| Shot | no、21 字段、reviewStatus、issueIds | `episodeId#SC01-SH001` |
| Prompt | shotNo、path、body、negative、params、mtime、parseStatus | `episodeId#SC01-SH001` |
| Asset | id、name、aliases、type、refs、ready | `projectRoot#asset:char-baixingxue` |
| SlotRef | shotNo、kind、slotNo、subjectName、assetId、status | `episodeId#SC01-SH001#subject:1` |
| Issue | shotNo、field、severity、source、status、desc、fix | uuid |
| StickyNote | content、shotNo?、locked、convertedIssueId? | uuid |

`reviewStatus`：`unread → read → flagged → confirmed`。
`SlotRef.status`：`ready / missing-file / missing-asset / ambiguous`。

## 6. SQLite 设计

数据库位置：`$APPDATA/com.workbench.app/index.db`（应用数据目录，不写项目目录）。路径由 `backend/core` 从入参接收，core 自身不假设位置——这样 M7 的服务端可以把它换成服务端数据目录，代码零改动。

### 6.1 表

```sql
-- 派生表：可清空重建
CREATE TABLE projects(root TEXT PRIMARY KEY, name TEXT, last_opened_at INTEGER);
CREATE TABLE episodes(id TEXT PRIMARY KEY, project_root TEXT, no TEXT, title TEXT,
                      path TEXT, target_dur REAL, total_dur REAL);
CREATE TABLE batches(id TEXT PRIMARY KEY, episode_id TEXT, no TEXT, title TEXT,
                     from_no TEXT, to_no TEXT);
CREATE TABLE scenes(id TEXT PRIMARY KEY, episode_id TEXT, no TEXT, name TEXT);
CREATE TABLE shots(id TEXT PRIMARY KEY, episode_id TEXT, no TEXT, scene_no TEXT,
                   size TEXT, angle TEXT, pos TEXT, move TEXT, dur REAL, beat TEXT,
                   raw_json TEXT);
CREATE TABLE prompts(id TEXT PRIMARY KEY, episode_id TEXT, shot_no TEXT, path TEXT,
                     body TEXT, negative TEXT, params_json TEXT, mtime INTEGER,
                     parse_status TEXT);
CREATE TABLE slots(id TEXT PRIMARY KEY, prompt_id TEXT, kind TEXT, slot_no INTEGER,
                   subject_name TEXT, asset_id TEXT, status TEXT);
CREATE TABLE assets(id TEXT PRIMARY KEY, project_root TEXT, name TEXT,
                    aliases_json TEXT, type TEXT, ready INTEGER, refs_json TEXT);

-- 用户表：不可重建
CREATE TABLE sticky_notes(id TEXT PRIMARY KEY, project_root TEXT, shot_no TEXT,
                          content TEXT, locked INTEGER, converted_issue_id TEXT,
                          created_at INTEGER, updated_at INTEGER);
CREATE TABLE issues(id TEXT PRIMARY KEY, episode_id TEXT, shot_no TEXT, field TEXT,
                    severity TEXT, source TEXT, status TEXT, desc TEXT, fix TEXT,
                    created_at INTEGER);
CREATE TABLE canvas_layout(project_root TEXT, episode_id TEXT, node_key TEXT,
                           x REAL, y REAL, PRIMARY KEY(project_root, episode_id, node_key));

-- 全文搜索
CREATE VIRTUAL TABLE prompts_fts USING fts5(body, content='prompts', content_rowid='rowid');
```

> FTS5 是否随 `libsqlite3-sys` 一起编译需要第一天验证；不可用则回退 `LIKE` + 前端内存过滤，接口保持不变。

### 6.2 重建策略

`重建索引` 只 `DELETE` 派生表再重新解析；用户表不动。实现为单个事务，失败回滚并保留旧索引。

## 7. 后端接口与权限

命令定义在 `backend/desktop/src/commands/`，实现体一律调 `backend/core`。web 不直接 `invoke`，只通过 `platform/transport/contract.ts` 触达。

| 命令 | 入参 | 返回 | 未来 HTTP 等价 |
| --- | --- | --- | --- |
| `scan_project` | `root` | `{ files, warnings }` | `GET /api/project/scan` |
| `pick_directory` | — | `string \| null` | 无（服务端托管） |
| `read_text_batch` | `root, paths[]` | `{ path: { text, mtime } }` | `POST /api/files/read` |
| `stat_paths` | `root, paths[]` | `{ path: { exists, mtime, size } }` | `POST /api/files/stat` |
| `asset_url` | `root, path` | `string` | `GET /api/assets/{path}` |
| `watch_start` | `root` | `void` | `POST /api/watch/start` |
| `watch_stop` | — | `void` | `POST /api/watch/stop` |
| `entity_put` | `{ table, rows[] }` | `void` | `POST /api/entities/{table}` |
| `entity_list` | `{ table, filter }` | `rows[]` | `GET /api/entities/{table}` |
| `search_prompts` | `q, limit` | `hits[]` | `GET /api/search` |
| `save_text` | `{ name, content }` | `string \| null` | `POST /api/export` |
| `clipboard_write` | `text` | `void` | 无（前端 `navigator.clipboard`） |
| `open_in_folder` | `root, path` | `void` | 无（服务端无桌面） |

事件：`project:changed` → `{ root, paths, kind }`。桌面走 `emit`，服务端走 `GET /api/events`（SSE），载荷同构。

错误统一返回 `{ code, message, detail? }`。`code` 是稳定枚举，前端按 code 降级、不解析 message：

```text
PATH_OUT_OF_SCOPE  路径越出项目根
PROJECT_NOT_FOUND  项目根不存在或缺 分镜.md
DB_CORRUPT         SQLite 损坏，已备份并重建
WATCH_UNAVAILABLE  监听启动失败，降级为手动刷新
PARSE_UNSUPPORTED  该文件类型不支持
```

权限最小化（`backend/desktop/capabilities/default.json`）：

- `dialog`: open / save（选项目根、导出另存）
- `clipboard-manager`: writeText
- `store`: 应用配置
- `opener`: 仅在文件管理器中定位文件
- **不启用 `fs`**：文件读取发生在 `core/fsio.rs` 的原生代码里，不经过 WebView 的 fs 插件，权限面更小；越界校验由 core 承担。
- 不启用 `http`、`shell`、任意 URL 打开。

CSP：

```text
default-src 'self';
img-src 'self' asset: http://asset.localhost blob: data:;
style-src 'self' 'unsafe-inline';
script-src 'self';
```

## 8. 画布实现

- **节点类型**：`batch` / `scene` / `shot` / `prompt` / `asset`，各自一个 React 组件，统一 160–200px 宽，异常态用红色边框。
- **边类型**：`contain`（灰实线）、`prompt`（灰实线）、`slot-ready`（绿实线）、`slot-missing`（红虚线）、`sticky`（黄虚线）。
- **布局**：默认按层计算坐标（批→场→镜→提示词→资产）；用户拖动后写 `canvas_layout`，重导入按 `node_key` 恢复。
- **性能**：开启 `onlyRenderVisibleElements`；超过 300 节点自动折叠非当前批次；`nodeTypes` / `edgeTypes` 必须定义在组件外，避免重复注册。
- **筛选**：只改变节点 `hidden` / `opacity`，不重建图结构。
- **便签贴附**：便签是 HTML 浮层（非 React Flow 节点），位置由「节点屏幕坐标 + 偏移」计算；画布缩放/平移时同步变换。

## 9. 关键实现细节

### 9.1 21 字段表格解析

用 `micromark` + `mdast-util-gfm-table` 拿到原始单元格，不直接手写正则切 `|`。步骤：

1. 找含 `镜号` 与至少 8 个字段名的表头行。
2. 以表头中文名映射英文短名（见 PRD 12.1），未知列保留为 `extra`。
3. 只接受第一列匹配 `^SC\d{2}-SH\d{3}(-[A-Z]\d?)?$` 的行。
4. 单元格保留原文；空串与 `—` 区分记录。
5. 解析失败 → `parseStatus = "unparsed"`，原表模式展示。

### 9.2 提示词 frontmatter

不依赖 gray-matter：用 `---\n` 边界切分，`js-yaml` 解析头部；正文保留原始换行。字段约定：

```yaml
shot: SC01-SH001
model: seedance
negative: "..."
params: { duration: 5, ratio: "9:16" }
subjects: { "1": 白兴学 }
pictures: { "1": 出租屋 }
```

### 9.3 复制策略

```ts
type CopyMode = "prompt" | "prompt+negative" | "prompt+params" | "full-file";
```

默认 `prompt`；拼接规则集中在 `domain/export/copy.ts`，便于后续加平台模板。

### 9.4 资产就绪

`ready = assets.json 中存在 && refs 全部可读`。图片 URL 统一由 `platform/image.ts` 产出：desktop 用 `convertFileSrc`（`asset:` 协议），web 模式返回 `GET /api/assets/{path}`；不可读时降级为占位，不影响其他节点。

### 9.5 便签持久化

- 输入即写 Zustand，500ms 防抖落库。
- 关闭窗口前 `flush()`（监听 `tauri://close-requested`，保存完再 `destroy`）。
- 未绑定便签（镜被删）保留，导出时需显式勾选。

## 10. 错误处理与降级

| 情况 | 行为 |
| --- | --- |
| 项目目录无 `分镜.md` | 空状态引导，指出缺少的文件名 |
| 表格解析失败 | 该集进入「原表模式」，画布只显示镜节点占位 |
| `assets.json` 缺失 | 扫目录结构；仍失败则资产面板显示「未接入」 |
| 图片读不到 | 占位图 + 「无法读取」，不阻断 |
| 文件监听失败 | 顶部提示「自动刷新不可用」，提供手动刷新 |
| SQLite 损坏 | 备份后重建派生表；用户表尝试导出为 JSON 备份 |
| FTS5 不可用 | 回退 `LIKE` 查询，UI 无感 |

## 11. 测试策略

- **Vitest（domain）**：表头映射、单元格脏数据、frontmatter、批次越界、槽位解析、graph 节点/边数量。用真实 Agent 产出做 fixtures。
- **Cargo test（backend/core）**：路径越界拦截、扫描过滤、去抖窗口合并、索引重建后用户表不丢、事务失败回滚。`tempfile` 建临时项目，不需要真窗口。
- **契约一致性（关键）**：`MockBackend`、`ipc.ts`、`http.ts` 共用同一套 conformance 用例；任何实现漏字段或改语义立刻失败。这是 M7 迁移不返工的唯一保险。
- **Vitest（browser 模式）**：注入 `MockBackend`，在无 Tauri 环境下跑 UI 全流程（导入 → 画布 → 预览 → 复制 → 便签 → 导出）。
- **WebdriverIO + tauri-driver**：真实外壳跑一遍最小闭环：选目录 → 节点数正确 → 点镜 → 预览字段 → 复制 → 便签落库 → 导出。
- **视觉回归**：Playwright 连浏览器模式，截关键面板。

## 12. 里程碑

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| M0 脚手架 | pnpm + Cargo 双工作区；`backend/core` 与 `desktop` 骨架；`web` 单页空壳；`transport/contract.ts` + `ipc.ts` + `MockBackend`；SQLite 迁移 | `pnpm dev` 起窗口；`cargo test -p core` 与契约用例全绿；迁移成功 |
| M1 导入与索引 | 扫描、读取、解析、校验、建库、重建索引 | 一集真实产出导入后镜数/总时长正确；删库可重建 |
| M2 画布与预览 | 五类节点、五类边、缩放拖拽、右侧面板四 tab | 点节点读全字段；布局重导入可恢复 |
| M3 批次与复制 | 批次条、折叠、筛选、一键复制四种模式 | 复制内容与原文一致；批次切换正确 |
| M4 便签与审阅 | 便签、问题清单、状态流转、意见导出 | 便签重启不丢；导出可被 Agent 直接执行 |
| M5 资产 | 资产看板、槽位映射、缺资产清单 | 缺图/未建/歧义三态正确 |
| M6 监听与打磨 | notify 增量、错误降级、性能优化 | 外部改稿 1s 内画布更新 |
| M7 服务化（可选） | `backend/server`：axum + SSE 复用 core；`transport/http.ts` | 同一份 `web` 构建连服务端时，契约用例全绿、功能等价 |

## 13. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `backend/core` 被误引入 tauri 依赖 | 未来无法被服务端复用 | CI 跑 `cargo tree -p core` 断言不含 `tauri` / `axum` |
| `features` 绕过 transport 直调插件 | 换后端时全量返工 | ESLint `no-restricted-imports`；只允许 `platform/transport` 与三个降级文件触达 `@tauri-apps/*` |
| 目录迁移后 Tauri 路径配置错 | 起不了窗口 | M0 先把 `frontendDist`（`../../web/dist`）与 `beforeDevCommand`（`pnpm -C web dev`）验证掉 |
| WebView2 版本差异 | 渲染/剪贴板行为不一致 | 声明最低 WebView2 版本；剪贴板走 Rust 插件 |
| FTS5 未编译 | 搜索不可用 | M0 用 `PRAGMA compile_options` 验证 bundled 是否含 FTS5；回退 LIKE |
| Markdown 脏数据 | 解析失败 | 原表模式兜底 + fixtures 覆盖 |
| 画布节点过多 | 卡顿 | 默认只看批次、折叠、`onlyRenderVisibleElements` |
| 文件监听风暴 | 频繁重建 | core 侧去抖 + 只重解析变更路径 |
| 动态图片作用域 | 权限报错 | `asset` 协议运行时 `allow_directory(root)`；失败降级为自定义协议 |

## 14. 待定

- 打包与签名：NSIS 还是 MSI；是否需要自动更新。
- 是否需要多窗口（画布 + 独立预览）。
- 契约生成方式：用 `tauri-specta` 从 Rust 命令生成 TS 类型，还是手写 `contract.ts` 并用 `shared/contracts/*.json` 做双向校验。M0 先手写，等命令数超过 15 个再评估。
- 服务化时机与形态（M7）：只在内网回环、需要登录，还是完全本地；是否需要多用户与冲突合并。
- 是否把 `web/src/domain` 提升为 `shared/domain` 包：若未来出现 Node 侧 CLI 或 Agent 校验器需要同一套解析，再提升；现在不动，避免过早抽象。
- 提示词平台模板（复制格式）是否配置化。

## 15. Toonflow 复用验证（2026-10-25）

**结论：不 fork、不做插件；只把它的画布交互当参考实现。** 验证方式为读源码 + 用真实分镜生成 `canvas.json` 做结构校验（脚本见 `spike/toonflow-canvas/convert.mjs`，非产品代码）。

| 问题 | 结论 | 依据 |
| --- | --- | --- |
| 能否把任意外部目录当项目 | 能，**仅桌面客户端** | `apps/server/src/utils/workspace/index.ts` L25：本地且本地请求时直接返回该目录；服务器/Docker 部署限制在 `data/workspaces` |
| 插件能否注册只读 md 视图 | 能，但只占一个标签页或一个画布节点 | `packages/extScaffold/readme.md`：`resourceKind: file \| canvasNode` |
| 画布能否脱离生成节点 | 能 | `apps/web/src/pages/workspace/canvasFiles.ts` L29–35 只校验 `toonflowCanvas` / `nodes` / `edges` / `viewport` |
| 技术栈 | Vue 3 + Vue Flow + Dockview + Element Plus + Pinia；外壳 electrobun（非 Electron） | `apps/web/package.json`、`apps/desktop/package.json` |

**阻断点**：文本节点正文在首次打开时被物化写入 `assets/<nodeId>/content.md`（`packages/nodes/textNode/src/index.vue` L147–160），之后在画布内的编辑只写这些派生文件，不回写 `分镜脚本.json`。即「画布内容」与「分镜原表」会双向不一致，违反 §2.1「项目目录是唯一真相」。

另：它没有批次条、便签、21 字段结构化视图与一键复制按钮，这四项恰好是 PRD 的核心。
