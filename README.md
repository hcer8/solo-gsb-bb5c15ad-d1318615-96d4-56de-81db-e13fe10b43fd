# config-merge-rehearsal-api

配置发布系统的**并发修改预演（dry-run rehearsal）服务**。客户端提交一份基准 JSON 文档和
A、B 两组 RFC 6902 补丁（仅支持 `add` / `remove` / `replace`），服务在**基准坐标系**下合并两组
补丁：以基准数组索引标识原元素、同一插入缝隙按 **A 后 B** 定序、自动重定位增删引起的索引漂移，
产出**确定的合并结果**；当两组补丁在同一元素/对象路径上发生「删除 vs 修改」或「不同值替换」等
冲突时，返回**结构化冲突**（含双方操作序号、规范化路径、原因）。

此外提供**变基（rebase）预演**：给定原始 `base`、基于 `base` 的待发布 `patch` 和上游新版本
`onto`，服务把 `base`→`onto` 的变化转换为基准坐标操作并与 `patch` 合并，返回合并结果与一份
**相对 `onto` 的可执行补丁**（服务端重放校验），冲突时只返回结构化冲突、不返回可执行补丁。

技术栈：Node.js 20+ · Fastify 5 · 纯内存存储（无外部依赖服务）。

---

## 快速开始

### 单条启动命令（Docker Compose，推荐）

```bash
docker compose up --build
```

依赖安装（`npm ci`）与初始化全部在镜像构建/启动阶段完成，无需额外步骤。

### 本地运行

```bash
npm ci && npm start
```

### 服务地址与端口

| 项 | 值 |
| --- | --- |
| 监听地址 | `0.0.0.0`（容器内） |
| 端口 | `3000` |
| 健康检查 | `http://localhost:3000/health` |
| 合并接口 | `POST http://localhost:3000/api/v1/merges` |
| 变基接口 | `POST http://localhost:3000/api/v1/rebases` |
| 约束预检接口 | `POST http://localhost:3000/api/v1/merges/:id/constraint-preview` |
| 归属预检接口 | `POST http://localhost:3000/api/v1/merges/:id/ownership-preview` |

## 配置项（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HOST` | `0.0.0.0` | 监听地址 |
| `LOG_LEVEL` | `info` | 日志级别（`debug` / `info` / `warn` / `error`） |
| `STORE_MAX` | `1000` | 内存中最多保留的预演记录数，超出后按 FIFO 淘汰 |

## API 一览

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 健康检查（存活/就绪探针） |
| `GET` | `/` | 服务元信息与端点清单 |
| `GET` | `/api/v1/example` | 返回示例请求体（干净合并 + 冲突各一份） |
| `POST` | `/api/v1/merges` | 执行合并预演，结果落内存存储 |
| `GET` | `/api/v1/merges` | 列出全部预演记录（摘要） |
| `GET` | `/api/v1/merges/:id` | 查询单条预演（含输入与结果） |
| `GET` | `/api/v1/merges/:id/order-audit` | 对已保存输入按严格 RFC 6902 顺序重放 A→B 与 B→A，判定可交换性 |
| `POST` | `/api/v1/merges/:id/resolution-preview` | 对冲突记录按冲突序号提交胜方决定（A/B），预览解决结果（不修改记录） |
| `GET` | `/api/v1/merges/:id/round-trip-plan` | 为干净合并记录生成确定性 RFC 6902 forward（base→merged）/ rollback（merged→base）补丁，服务端重放校验后返回 |
| `GET` | `/api/v1/merges/:id/provenance` | 干净合并记录的叶子级来源追踪：`merged` 每个叶子路径标注 `base` / `A` / `B` / `both` 及贡献操作的原始序号 |
| `POST` | `/api/v1/merges/:id/constraint-preview` | 对干净合并记录提交一组条件规则（`when` 指针值与 `equals` 深度相等时 `require` 指针必须存在），在基准 / A 单独 / B 单独 / 合并结果四种状态上评估并分类合并结果中的违规（不修改记录） |
| `POST` | `/api/v1/merges/:id/ownership-preview` | 对任意已保存记录提交路径归属规则（唯一 `prefix` → `owner` A/B），按基准坐标最长前缀逐条检查原始操作的归属，返回可发布布尔值与违规明细（不修改记录） |
| `POST` | `/api/v1/rebases` | 变基预演：把基于 `base` 的 `patch` 迁移到新版本 `onto`，返回 `merged` 与相对 `onto` 的 `rebasedPatch`（服务端重放校验），冲突时不返回可执行补丁 |
| `DELETE` | `/api/v1/merges/:id` | 删除单条预演（`204`） |

### `POST /api/v1/merges`

请求体：

```json
{
  "base":   { "任意": "JSON 文档" },
  "patchA": [ { "op": "replace", "path": "/replicas", "value": 3 } ],
  "patchB": [ { "op": "remove",  "path": "/servers/0" } ]
}
```

- `base`：任意 JSON 文档（对象、数组、标量均可）。
- `patchA` / `patchB`：RFC 6902 操作数组，**仅接受 `add` / `remove` / `replace`**；
  其他操作（`move`/`copy`/`test`）返回 `400`。
- 两组补丁都针对**同一份基准文档**求值（模拟两个变更基于同一版本并发提出）。

响应：

- **合并干净 → `200`**：`{ id, status: "clean", merged, conflicts: [], stats, createdAt }`
- **存在冲突 → `409`**：`{ id, status: "conflict", merged: null, conflicts: [...], stats, createdAt }`
- **补丁不合法（路径不存在、越界、缺 `value` 等）→ `422`**：
  `{ statusCode, error, code: "INVALID_PATCH", message, details: { side, index } }`
- **请求体结构/操作类型不合法 → `400`**

无论 `200` 还是 `409`，记录都会存入内存存储，可凭 `id` 查询。

### `GET /api/v1/merges/:id/order-audit`（顺序审计）

对一条**已保存**的预演记录，把其 `patchA`、`patchB` 当作两组**严格按 RFC 6902 顺序执行**的
补丁，分别重放两种次序：

- `A->B`：先逐条应用 `patchA`，再逐条应用 `patchB`；
- `B->A`：先 `patchB`，再 `patchA`。

与 `POST /api/v1/merges` 的**基准坐标合并模型**不同，顺序审计里**每组补丁内部逐条作用于上一
条操作的结果**：路径中的数组下标始终相对**当前文档**解析，增删引起的下标漂移**不会**被重定位
回基准坐标（这正是 RFC 6902 的原生执行方式）。

- 每组补丁内部第 N 条操作作用于第 0..N-1 条执行后的文档；
- 数组下标不沿用基准坐标——先插入/删除后，后续操作按新下标求值；
- 审计是已保存输入的纯函数：同一记录重复查询返回**逐字节一致**的结果（服务端按记录缓存）；
- 记录不存在时返回 `404`。

#### 响应结构

```jsonc
{
  "id": "...",
  "createdAt": "...",
  "verdict": "commutative | divergent | failed",
  "base": { /* 保存时的基准文档 */ },
  "orders": {
    "A->B": {
      "status": "applied | failed",
      "steps": [
        {
          "order": "A->B",
          "side": "A",            // 该操作来自哪组补丁
          "index": 0,             // 该操作在其原始补丁中的序号（0 起）
          "op": "add",
          "path": "/servers/1",
          "afterExists": true,    // 执行后该路径是否存在
          "afterValue": { }       // 执行后该路径上的值（remove 时为 null）
          // "removedValue" 仅在成功的 remove 步骤上出现：被删除的值
        }
        // …按执行顺序排列的逐条轨迹（路径 + 执行后值）
      ],
      "finalDocument": { /* 成功时为最终文档；失败时为 null */ },
      "failure": null // 或见下
    },
    "B->A": { /* 同上 */ }
  },
  "firstDifference": null
}
```

#### 三种判定（`verdict`）

| `verdict` | 条件 |
| --- | --- |
| `commutative` | 两种顺序都成功，且最终文档深度相等（两组补丁可交换） |
| `divergent` | 两种顺序都成功但最终文档不同；`firstDifference` 递归给出 RFC 6901 **字典序最小**的差异路径及两侧值 |
| `failed` | 至少一种顺序失败 |

`divergent` 时的 `firstDifference`：

```json
{
  "path": "/servers/0/host",   // 字典序最小的差异指针（按转义后的 ~0/~1 比较）
  "aExists": true,             // A->B 结果在该路径是否存在
  "aValue": "a2.internal",     // A->B 一侧的值（不存在时为 null）
  "bExists": true,             // B->A 结果在该路径是否存在
  "bValue": "b.internal"       // B->A 一侧的值（不存在时为 null）
}
```

> 容器与非容器在同一路径上的类型变化（如对象 vs `null`、数组 vs 标量）即视为该路径上的叶子差异；
> 一侧缺失成员时以 `aExists`/`bExists` 区分，与「值恰好为 `null`」不相混淆。

`failed` 时，失败方的 `failure` 字段给出**失败方、原始操作序号和失败前文档**：

```jsonc
{
  "order": "A->B",
  "side": "B",                 // 失败的是哪组补丁
  "index": 0,                  // 失败操作在其原始补丁中的序号
  "op": "replace",
  "path": "/l/1/h",
  "code": "OUT_OF_BOUNDS",     // INVALID_PATH / INVALID_INDEX / OUT_OF_BOUNDS /
                               // PATH_NOT_FOUND / MISSING_VALUE /
                               // UNSUPPORTED_OP / TRAVERSAL_ERROR /
                               // ROOT_NOT_REMOVABLE / INVALID_OPERATION
  "message": "array index 1 out of bounds (length 1) at /l/1",
  "documentBefore": { "l": [ { "h": "b" } ] }  // 紧接失败操作之前的整份文档
}
```

失败方的 `steps` 只包含失败前已成功的操作（其副作用即体现在 `documentBefore` 中），
`finalDocument` 为 `null`；另一顺序若成功仍正常返回其轨迹与最终文档。

示例：

```bash
curl -s http://localhost:3000/api/v1/merges/<id>/order-audit | jq
```

以 `examples/merge-request.json` 为例，`POST` 的基准坐标合并是干净的，但严格 RFC 6902
顺序重放得到 `divergent`：同一下标缝隙的插入在两种次序下落点不同，最小差异路径为
`/servers/0/host`（`A->B` 为 `a2.internal`，`B->A` 为 `b.internal`）。

### `POST /api/v1/merges/:id/resolution-preview`（冲突解决预览）

对一条 **`status` 为 `conflict`** 的已保存记录，按**冲突数组序号**逐项提交胜方决定
（`A` 或 `B`）。服务从原 `patchA`/`patchB` 中剔除各冲突的败方操作，重新调用基准坐标
合并逻辑并返回预览。**预览不会修改已保存的记录**，同一记录同一请求重复提交返回
**逐字节一致**的结果。

请求体（也见 `examples/resolution-preview-request.json`）：

```json
{
  "decisions": [
    { "conflict": 0, "winner": "A" },
    { "conflict": 1, "winner": "B" }
  ]
}
```

- `conflict`：记录 `conflicts` 数组中的序号（0 起）；`winner`：该冲突保留哪一方的操作。
- `decisions` 必须**恰好覆盖全部冲突**：每个冲突恰好一次；缺漏、重复或越界序号返回
  `400`（`code: "INVALID_DECISIONS"`，`missing` / `duplicate` / `unexpected` 列出问题序号）。

响应：

- **冲突全部解决 → `200`**：
  `{ id, status: "clean", merged, conflicts: [], retained, dropped, stats }`
- **剔除败方后仍有冲突 → `409`**：
  `{ id, status: "conflict", merged: null, conflicts: [...], retained, dropped, stats }`
  （例如被补丁内 last-wins 覆盖的旧操作在胜方被剔除后重新浮现，与另一方产生新的冲突；
  返回的 `conflicts` 为对过滤后补丁重新合并得到的剩余冲突）
- **决定自相矛盾 → `422`**：同一原始操作在不同冲突中既被要求保留又被要求丢弃，返回
  `{ code: "CONTRADICTORY_DECISIONS", contradictions: [...] }`，每条矛盾列出操作
  （`side`、`index`、`op`、`path`、`value`）及相关冲突序号（`retainedIn` / `droppedIn`）。
- **记录不存在 → `404`**；**记录不是冲突状态 → `409`**；请求体结构不合法 → `400`。

`retained` / `dropped` 逐项列出被保留 / 被剔除的**原始操作**（`side`、`index` 为该操作在
原补丁中的序号、`op`、`path`、`value`），其 `conflicts` 字段标明决定它的冲突序号；两者均按
（side, index）排序，保证序列化确定。

完整流程示例：

```bash
# 1) 提交冲突示例，记下返回的记录 id
id=$(curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/conflict-request.json | jq -r .id)

# 2) 预览解决：冲突 0 保留 A 的删除，冲突 1 采用 B 的 mode
curl -s -X POST "http://localhost:3000/api/v1/merges/$id/resolution-preview" \
  -H 'Content-Type: application/json' \
  -d @examples/resolution-preview-request.json | jq
# => 200, merged: { "mode": "readonly" }；记录本身仍为 conflict，可换其他决定重试
```

### `GET /api/v1/merges/:id/round-trip-plan`（往返补丁计划）

对一条**已保存且合并成功（`status: "clean"`）**的记录，根据其保存的 `base` 与 `merged`
生成两组**仅含 `add` / `remove` / `replace`** 的确定性 RFC 6902 补丁：

- `forward`：`base` → `merged`（执行即得到合并结果）；
- `rollback`：`merged` → `base`（执行即把合并结果回滚回基准）。

补丁是 `base`、`merged` 的**纯函数**，生成规则完全确定：

- **对象**：键按**字典序**（UTF-16 码元顺序，与区域设置无关）处理，引用记号按 RFC 6901
  转义（`~` → `~0`、`/` → `~1`）；仅存在于一侧的成员发 `add` / `remove`，两侧都有但不同的
  标量叶子发 `replace`，容器递归比较。
- **数组**：用深度相等元素的**最长公共子序列（LCS）**对齐——相等元素原地保留，其余基准元素
  一律 `remove`、其余结果元素一律 `add`（相等元素内部不做逐下标深改）。
- **下标安全的发射次序**：同一数组内删除按基准下标**降序**发出（先删高位，低位下标不漂移），
  插入按**最终下标升序**发出（从左到右重建），因此每条操作的数组下标在**执行当下**始终有效。

服务端在返回前会**实际重放两组补丁**做校验：只有 `forward` 应用于 `base` **恰好得到 `merged`**、
且 `rollback` 应用于 `merged` **恰好恢复 `base`** 时才返回结果；任一校验失败按 `500` 处理
（正常输入下不会发生）。响应同时给出每个方向各操作类型的操作数。

#### 响应结构（`200`）

```jsonc
{
  "id": "...",
  "createdAt": "...",
  "status": "clean",
  "base":   { /* 保存时的基准文档 */ },
  "merged": { /* 合并结果 */ },
  "forward": [
    { "op": "add",     "path": "/features/retries", "value": 3 },
    { "op": "replace", "path": "/features/tracing", "value": true },
    { "op": "replace", "path": "/replicas", "value": 3 },
    { "op": "remove",  "path": "/servers/0" },
    { "op": "add", "path": "/servers/0", "value": { "host": "a2.internal", "port": 8080 } },
    { "op": "add", "path": "/servers/1", "value": { "host": "b2.internal", "port": 9090 } }
  ],
  "rollback": [
    { "op": "remove",  "path": "/features/retries" },
    { "op": "replace", "path": "/features/tracing", "value": false },
    { "op": "replace", "path": "/replicas", "value": 2 },
    { "op": "remove",  "path": "/servers/1" },
    { "op": "remove",  "path": "/servers/0" },
    { "op": "add", "path": "/servers/0", "value": { "host": "a.internal", "port": 8080 } }
  ],
  "operationCount": {
    "forward":  { "add": 3, "remove": 1, "replace": 2, "total": 6 },
    "rollback": { "add": 1, "remove": 3, "replace": 2, "total": 6 }
  }
}
```

可以看到：对象操作按字典序（`features` 在 `replicas` 之前，`replicas` 在 `servers` 之前，
`features` 内部 `retries` 在 `tracing` 之前）；`servers` 先降序删除，再按最终下标升序插入——
逐条按 RFC 6902 执行即可精确得到 `merged`。

#### 状态码与确定性

- **干净记录 → `200`**：返回上述计划。
- **冲突记录（`status: "conflict"`）→ `409`**：冲突记录没有 `merged`，不生成计划，
  且**不修改记录**；返回 `{ statusCode, error: "Conflict", message }`。
- **记录不存在 → `404`**。
- 计划按记录在服务端缓存：对**同一条记录重复请求**返回**逐字节一致**的响应（不重新重放）。
- 文档根若整体改变（如标量↔容器），使用 `replace` 路径 `""`；`base` 与 `merged` 深度相等时
  两组补丁均为空数组、操作数全为 `0`。

示例：

```bash
curl -s http://localhost:3000/api/v1/merges/<id>/round-trip-plan | jq
```

### `GET /api/v1/merges/:id/provenance`（叶子来源追踪）

对一条**已保存且合并成功（`status: "clean"`）**的记录，报告 `merged` 中**每个叶子路径**
的值来自哪里：

| `source` | 含义 |
| --- | --- |
| `base` | 叶子原样来自基准文档，未被任何操作触碰 |
| `A` / `B` | 叶子由该方补丁的操作写入 |
| `both` | 双方在同一目标写入了**深度相等**的值（合并时去重为一次，来源仍记双方） |

归属规则：

- **叶子**指标量、`null` 与**空容器**（`{}` / `[]`：没有子节点可归属，自身即叶子）；
  文档根本身为标量或空容器时，唯一叶子路径是 `""`。
- `operations` 列出**贡献操作**的 `side` 与在原始 `patchA` / `patchB` 中的**序号**（0 起）；
  `base` 叶子的 `operations` 为空数组。
- **后写覆盖**：补丁内同路径 last-wins，被覆盖的操作不贡献、不出现；**删除后重建**
  （同补丁先 `remove` 后 `add` 同一路径）只归属重建操作。
- 路径是 `merged` 中的**最终 JSON Pointer**（RFC 6901 转义），完全沿用基准坐标合并的
  数组重定位规则：删除使幸存元素前移、**同缝隙插入按 A 后 B 落位**、元素内部深改跟随
  基准元素身份漂移——来源标签与 `merged` 的实际结构一一对应。
- 叶子按路径以 **UTF-16 码元序**排序（与区域设置无关；`/l/10` 排在 `/l/2` 之前）。

#### 响应结构（`200`）

以 `examples/merge-request.json` 为例：

```jsonc
{
  "id": "...",
  "createdAt": "...",
  "status": "clean",
  "leaves": [
    { "path": "/app", "source": "base", "operations": [] },
    { "path": "/features/cache", "source": "base", "operations": [] },
    { "path": "/features/retries", "source": "B",
      "operations": [ { "side": "B", "index": 2 } ] },
    { "path": "/features/tracing", "source": "both",
      "operations": [ { "side": "A", "index": 2 }, { "side": "B", "index": 3 } ] },
    { "path": "/replicas", "source": "A",
      "operations": [ { "side": "A", "index": 0 } ] },
    { "path": "/servers/0/host", "source": "A",
      "operations": [ { "side": "A", "index": 1 } ] }
    // …按路径排序的全部 12 个叶子
  ],
  "summary": { "total": 12, "base": 5, "A": 3, "B": 3, "both": 1 }
}
```

可以看到：`servers[0]` 被 B 删除后，A、B 在同一缝隙（基准索引 1）插入的元素依次落在
最终下标 0、1；双方对 `/features/tracing` 的相同写入记为 `both` 并列出双方序号。

#### 状态码与确定性

- **干净记录 → `200`**：返回上述结构。
- **冲突记录（`status: "conflict"`）→ `409`**：冲突记录没有 `merged` 可归属，
  且**不修改记录**；返回 `{ statusCode, error: "Conflict", message }`。
- **记录不存在 → `404`**。
- 归属结果按记录在服务端缓存：对**同一条记录重复请求**返回**逐字节一致**的响应。

示例：

```bash
curl -s http://localhost:3000/api/v1/merges/<id>/provenance | jq
```

### `POST /api/v1/merges/:id/constraint-preview`（条件约束预检）

对一条**已保存且合并成功（`status: "clean"`）**的记录，提交一组**带唯一 `id` 的条件规则**，
在四种状态上分别评估每条规则，并对合并结果中的违规给出归因分类。**预检不会修改已保存的
记录**，同一记录同一请求重复提交返回**逐字节一致**的结果。

规则语义：当 `when`（JSON Pointer）指向的值与 `equals`（任意 JSON 值）**深度相等**时，
`require`（另一个 JSON Pointer）**必须存在**。一条规则在某份文档上**通过**当且仅当：

- `when` 指针不存在，或
- `when` 指向的值与 `equals` 不深度相等（对象键序无关），或
- `require` 指针存在（**值为 `null` 也算存在**，与指针缺失区分）。

请求体（也见 `examples/constraint-preview-request.json`，或 `GET /api/v1/example`）：

```json
{
  "rules": [
    { "id": "tracing-needs-audit",
      "when": "/features/tracing", "equals": true, "require": "/features/audit" },
    { "id": "first-server-needs-verification",
      "when": "/servers/0/host", "equals": "a2.internal", "require": "/servers/0/verified" }
  ]
}
```

- `id`：非空字符串，组内唯一；`when` / `require`：RFC 6901 JSON Pointer（`""` 表示文档根，
  `~0` / `~1` 转义）；`equals`：任意 JSON 值（含 `null`），必填。
- 四个字段均为必填，不识别多余字段；`rules` 按请求顺序求值与返回，空数组合法。

#### 四种评估状态

| 状态 | 文档 |
| --- | --- |
| `base` | 保存的基准文档 |
| `A` | 基准 + **A 单独变更**：`patchA` 与空补丁按**基准坐标合并语义**合并的结果（与 `POST /api/v1/merges` 同一引擎，数组索引按基准元素身份重定位） |
| `B` | 基准 + **B 单独变更**，同上 |
| `merged` | 保存的合并结果 |

#### 合并结果违规的归因分类（`violation.labels`）

仅当规则在 `merged` 状态被违反时返回 `violation`，其 `labels` 取值：

| 标签 | 含义 |
| --- | --- |
| `preexisting` | **既存**：基准文档上就已违规（无论两侧各自如何，均只标此标签） |
| `introduced-by-A` | **A 引入**：基准干净，A 单独变更即违规 |
| `introduced-by-B` | **B 引入**：基准干净，B 单独变更即违规 |
| `combination-only` | **仅组合后出现**：基准与两侧单独变更都干净，只有合并结果违规 |

**两侧均单独违规时同时标出 A/B**（`["introduced-by-A", "introduced-by-B"]`）。

#### 响应结构（`200`）

以 `examples/merge-request.json` 创建记录、再提交
`examples/constraint-preview-request.json` 为例（节选两条规则）：

```jsonc
{
  "id": "...",
  "createdAt": "...",
  "status": "clean",
  "results": [
    {
      "id": "tracing-needs-audit",
      "when": "/features/tracing",
      "equals": true,
      "require": "/features/audit",
      "states": {
        "base":   { "pass": true,  "triggered": false, "whenExists": true, "whenValue": false, "requireExists": false },
        "A":      { "pass": false, "triggered": true,  "whenExists": true, "whenValue": true,  "requireExists": false },
        "B":      { "pass": false, "triggered": true,  "whenExists": true, "whenValue": true,  "requireExists": false },
        "merged": { "pass": false, "triggered": true,  "whenExists": true, "whenValue": true,  "requireExists": false }
      },
      "violation": { "labels": ["introduced-by-A", "introduced-by-B"] }
    },
    {
      "id": "first-server-needs-verification",
      "when": "/servers/0/host",
      "equals": "a2.internal",
      "require": "/servers/0/verified",
      "states": {
        "base":   { "pass": true, "triggered": false, "whenExists": true, "whenValue": "a.internal",  "requireExists": false },
        "A":      { "pass": true, "triggered": false, "whenExists": true, "whenValue": "a.internal",  "requireExists": false },
        "B":      { "pass": true, "triggered": false, "whenExists": true, "whenValue": "b2.internal", "requireExists": false },
        "merged": { "pass": false, "triggered": true, "whenExists": true, "whenValue": "a2.internal", "requireExists": false }
      },
      "violation": { "labels": ["combination-only"] }
    }
    // …按请求顺序的全部规则
  ],
  "summary": {
    "total": 6,
    "violations": { "base": 1, "A": 3, "B": 3, "merged": 5 },
    "mergedViolations": { "preexisting": 1, "introducedByA": 1, "introducedByB": 1,
                          "introducedByBoth": 1, "combinationOnly": 1 }
  }
}
```

每个状态的评估明细：`pass`（是否通过）、`triggered`（`when` 存在且与 `equals` 深度相等）、
`whenExists` / `whenValue`（`when` 指针是否存在及指向的值，不存在时 `whenValue` 为 `null`）、
`requireExists`。`summary.mergedViolations` 按五类**互不重叠**地统计合并结果违规
（`introducedByBoth` 指两侧均单独违规的情形）。

#### 状态码与确定性

- **干净记录 → `200`**：返回上述结构。
- **规则无效 → `422`**：`{ statusCode, error, code: "INVALID_RULES", message, invalid: [...] }`；
  `invalid` 按请求顺序列出每条问题规则的 `index`、`id`（无法解析时为 `null`）与 `issues`
  （非对象、缺字段、`id` 为空或重复、指针非法、多余字段等）。
- **记录不存在 → `404`**；**记录为冲突状态（`status: "conflict"`）→ `409`**（无 `merged`
  可评估，不修改记录；`409` 先于规则校验）；请求体缺 `rules` 等结构问题 → `400`。
- 预检是已保存记录与请求规则的**纯函数**：不修改记录，同一请求重复提交返回逐字节一致的结果。

完整流程示例：

```bash
# 1) 用干净合并示例创建记录，记下 id
id=$(curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/merge-request.json | jq -r .id)

# 2) 提交条件规则预检
curl -s -X POST "http://localhost:3000/api/v1/merges/$id/constraint-preview" \
  -H 'Content-Type: application/json' \
  -d @examples/constraint-preview-request.json | jq
# => 200；六条规则分别演示 preexisting / introduced-by-A / introduced-by-B /
#    双侧同时违规 / combination-only 与全状态通过
```

### `POST /api/v1/merges/:id/ownership-preview`（路径归属预检）

对一条**已保存**的预演记录（干净或冲突均可），提交一组**路径归属规则**，逐条检查原始
`patchA` / `patchB` 操作是否越界写入他方领地，返回**可发布（`publishable`）**判定。
**预检不会修改已保存的记录**，同一记录同一请求重复提交返回**逐字节一致**的结果。

规则语义：每条规则把一棵子树划归一方——

```json
{ "prefix": "/features", "owner": "A" }
```

- `prefix`：RFC 6901 JSON Pointer（`""` 表示文档根，`~0` / `~1` 转义），组内**唯一**；
- `owner`：归属方，`"A"` 或 `"B"`；
- 两个字段均为必填，不识别多余字段；`rules` 按请求顺序校验，空数组合法
  （此时任何操作都因未被覆盖而违规）。

请求体（也见 `examples/ownership-preview-request.json`，或 `GET /api/v1/example`）：

```json
{
  "rules": [
    { "prefix": "/app", "owner": "A" },
    { "prefix": "/servers", "owner": "B" },
    { "prefix": "/servers/0/host", "owner": "A" },
    { "prefix": "/features", "owner": "A" },
    { "prefix": "/features/tracing", "owner": "B" }
  ]
}
```

#### 判定规则

对每条**原始操作**（按 A 后 B、补丁内序号顺序；包括合并时会被 last-wins 覆盖或去重的
操作）在**基准坐标**下检查：

1. **最长前缀归属**：操作目标路径（基准文档路径）归属**最长匹配**的规则前缀。
   没有任何规则覆盖的路径直接判违规（`uncovered-path`，命中规则为 `null`）；
   命中规则的 `owner` 与操作方不一致判违规（`owned-by-other`）。
2. **数组插入按父数组归属**：`add /arr/i`（含 `-`）的插入位置按**父数组路径** `/arr`
   匹配规则，而不是按尚不存在的元素路径。
3. **后代规则保护**：`replace` / `remove`（含「覆盖已有对象成员的 `add`」——合并引擎
   会将其规范化为 `replace`）会整体改写/删除目标子树，若**目标之下**存在归属另一方的
   后代规则，每条各判一次违规（`descendant-owned-by-other`，按规则前缀排序），防止
   父节点写入绕过嵌套领地保护。纯新增对象成员的 `add` 不触发此项检查。

`publishable` 为 `true` 当且仅当违规列表为空。

#### 响应结构（`200`）

以 `examples/merge-request.json` 创建记录、再提交
`examples/ownership-preview-request.json` 为例：

```jsonc
{
  "id": "...",
  "createdAt": "...",
  "status": "clean",
  "publishable": false,
  "violations": [
    { "side": "A", "index": 0, "op": "replace", "path": "/replicas",
      "reason": "uncovered-path", "rule": null },
    { "side": "A", "index": 1, "op": "add", "path": "/servers/1",
      "reason": "owned-by-other", "rule": { "prefix": "/servers", "owner": "B" } },
    { "side": "A", "index": 2, "op": "replace", "path": "/features/tracing",
      "reason": "owned-by-other", "rule": { "prefix": "/features/tracing", "owner": "B" } },
    { "side": "B", "index": 0, "op": "remove", "path": "/servers/0",
      "reason": "descendant-owned-by-other",
      "rule": { "prefix": "/servers/0/host", "owner": "A" } },
    { "side": "B", "index": 2, "op": "add", "path": "/features/retries",
      "reason": "owned-by-other", "rule": { "prefix": "/features", "owner": "A" } }
  ],
  "summary": {
    "operations": { "A": 3, "B": 4, "total": 7 },
    "violations": 5,
    "byReason": { "uncovered-path": 1, "owned-by-other": 3,
                  "descendant-owned-by-other": 1 },
    "bySide": { "A": 3, "B": 2 }
  }
}
```

每条违规给出：`side`（方别）、`index`（操作在原补丁中的**原始序号**，0 起）、
`op`（原始操作类型）、`path`（基准坐标下的规范化路径，RFC 6901 转义）、
`reason`（原因）与 `rule`（命中规则；`uncovered-path` 时为 `null`）。

#### 状态码与确定性

- **任意状态的记录 → `200`**：干净或冲突记录均可预检——只读取保存的
  `base` / `patchA` / `patchB`，不依赖 `merged`。
- **规则无效 → `422`**：`{ statusCode, error, code: "INVALID_RULES", message, invalid: [...] }`；
  `invalid` 按请求顺序列出每条问题规则的 `index`、`prefix`（无法解析时为 `null`）与
  `issues`（非对象、缺字段、`prefix` 非法或重复、`owner` 非 A/B、多余字段等）。
- **记录不存在 → `404`**；请求体缺 `rules` 等结构问题 → `400`。
- 预检是已保存记录与请求规则的**纯函数**：不修改记录，同一请求重复提交返回
  逐字节一致的结果。

完整流程示例：

```bash
# 1) 用干净合并示例创建记录，记下 id
id=$(curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/merge-request.json | jq -r .id)

# 2) 提交路径归属规则预检
curl -s -X POST "http://localhost:3000/api/v1/merges/$id/ownership-preview" \
  -H 'Content-Type: application/json' \
  -d @examples/ownership-preview-request.json | jq
# => 200；publishable: false，5 条违规覆盖 uncovered-path /
#    owned-by-other / descendant-owned-by-other 三种原因
```

### `POST /api/v1/rebases`（变基预演）

把一份**基于旧版本 `base` 的待发布补丁**迁移到上游新版本 `onto` 上。服务先把 `base` → `onto`
的变化转换为合并引擎的**基准坐标操作**（记为 `upstream`）：对象按键寻址；数组按深度相等元素的
**最长公共子序列（LCS）**对齐——相等元素保留身份原地不动，未匹配的基准元素按**基准下标**删除、
未匹配的目标元素按**基准缝隙**插入，连续插入归入同一缝隙并按序累积。随后 `upstream`（作为 A 方）
与客户端 `patch`（作为 B 方）在基准坐标下合并（与 `POST /api/v1/merges` 同一引擎、同一冲突模型）。

请求体（也见 `examples/rebase-request.json`，或 `GET /api/v1/example`）：

```json
{
  "base":  { "任意": "JSON 文档" },
  "patch": [ { "op": "replace", "path": "/replicas", "value": 3 } ],
  "onto":  { "上游": "新版本文档" }
}
```

- `base`：补丁最初针对的原始文档；`patch`：基于 `base` 的 RFC 6902 操作数组
  （仅 `add` / `remove` / `replace`）；`onto`：上游新版本文档。

响应：

- **变基干净 → `200`**：

  ```jsonc
  {
    "status": "clean",
    "merged": { /* base + 上游变化 + 客户端补丁的合并结果 */ },
    "rebasedPatch": [ /* 相对 onto 的 RFC 6902 补丁：作用于 onto 恰好得到 merged */ ],
    "upstream": [ /* base→onto 的基准坐标操作（合并引擎的 A 方输入） */ ],
    "conflicts": []
  }
  ```

  `rebasedPatch` 只含 `add` / `remove` / `replace`，按严格 RFC 6902 顺序执行；服务端在返回前
  **实际重放**该补丁，确认 `apply(onto, rebasedPatch)` 与 `merged` 深度相等（校验失败按 `500`
  处理，正常输入下不会发生）。

- **存在冲突 → `409`**：

  ```jsonc
  {
    "status": "conflict",
    "merged": null,
    "rebasedPatch": null,          // 冲突时不返回可执行补丁
    "upstream": [ /* 同上 */ ],
    "conflicts": [
      {
        "reason": "replace-mismatch",
        "path": "/mode",
        "operations": [
          { "side": "A", "index": 0, "op": "replace", "path": "/mode", "value": "readonly" },
          { "side": "B", "index": 0, "op": "replace", "path": "/mode", "value": "single" }
        ],
        "message": "both patches replace the same target with different values (A#0 vs B#0)"
      }
    ]
  }
  ```

  冲突结构与 `POST /api/v1/merges` 完全一致（`reason` / `path` / 双方操作 / `message`）。
  `operations` 中 **`side: "A"` 指上游操作**，`index` 为响应 `upstream` 数组的下标；
  **`side: "B"` 指客户端 `patch`**，`index` 为请求体补丁中的操作序号（0 起）。

- **补丁不合法（路径不存在、越界、缺 `value` 等）→ `422`**：同 `POST /api/v1/merges`，
  `{ statusCode, error, code: "INVALID_PATCH", message, details: { side, index } }`
  （客户端 `patch` 的问题记 `side: "B"`）。
- **请求体结构/操作类型不合法 → `400`**。

说明：

- 变基是**无状态**的：结果不落内存存储，同一请求重复提交返回**逐字节一致**的响应。
- 上游与客户端在**同一数组缝隙**都插入时，上游元素排在客户端之前（A 后 B 定序的自然延伸）。
- 客户端补丁里的数组下标按**基准坐标**解释：上游删除使元素前移时，补丁对幸存元素的修改
  仍跟随其基准身份落位（见下例）。

完整流程示例：

```bash
# 干净变基：上游删除 servers[0]、追加一台机器、开启 tracing、新增 region；
# 客户端补丁把 replicas 改为 3 并新增 features.retries —— 两边互不相交
curl -s -X POST http://localhost:3000/api/v1/rebases \
  -H 'Content-Type: application/json' \
  -d @examples/rebase-request.json | jq
# => 200；rebasedPatch 为
#    [ { "op": "add", "path": "/features/retries", "value": 3 },
#      { "op": "replace", "path": "/replicas", "value": 3 } ]
#    把它按 RFC 6902 作用于 onto 即得 merged

# 冲突变基：上游把 /mode 改为 readonly 并删除 servers[0]；
# 客户端补丁替换 /mode 并修改 servers[0] 内部
curl -s -X POST http://localhost:3000/api/v1/rebases \
  -H 'Content-Type: application/json' \
  -d @examples/rebase-conflict-request.json | jq
# => 409；conflicts 给出 replace-mismatch（/mode，A#0 vs B#0）与
#    delete-vs-modify（/servers/0，A#1 vs B#1），rebasedPatch 为 null
```

## 示例请求

干净合并（也见 `examples/merge-request.json`，或 `GET /api/v1/example`）：

```bash
curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/merge-request.json | jq
```

该示例中：A 把 `replicas` 改为 `3`、在 `servers` 索引 1 处插入一台机器、开启 `tracing`；
B 删除 `servers[0]`、在**同一插入缝隙**（索引 1）插入另一台机器、新增 `features.retries`、
同样开启 `tracing`。合并结果：

```json
{
  "status": "clean",
  "merged": {
    "app": "payment-service",
    "replicas": 3,
    "servers": [
      { "host": "a2.internal", "port": 8080 },
      { "host": "b2.internal", "port": 9090 },
      { "host": "b.internal",  "port": 8080 }
    ],
    "features": { "cache": true, "tracing": true, "retries": 3 },
    "tags": ["stable"]
  },
  "stats": { "received": { "A": 3, "B": 4 }, "normalized": { "A": 3, "B": 4 },
             "deduplicated": 1, "conflicts": 0, "applied": 6 }
}
```

可以看到：同一缝隙的插入按 **A 后 B** 排列；`servers[0]` 被删除后其余元素按基准身份
重新定位；双方对 `/features/tracing` 的相同修改被去重（`deduplicated: 1`）。

冲突示例（`examples/conflict-request.json`）：

```bash
curl -s -X POST http://localhost:3000/api/v1/merges \
  -H 'Content-Type: application/json' \
  -d @examples/conflict-request.json | jq
```

返回 `409`：

```json
{
  "status": "conflict",
  "merged": null,
  "conflicts": [
    {
      "reason": "delete-vs-modify",
      "path": "/database",
      "operations": [
        { "side": "A", "index": 0, "op": "remove",  "path": "/database" },
        { "side": "B", "index": 0, "op": "replace", "path": "/database/host", "value": "db2.internal" }
      ],
      "message": "one patch deletes this element while the other modifies it (A#0 vs B#0)"
    },
    {
      "reason": "replace-mismatch",
      "path": "/mode",
      "operations": [
        { "side": "A", "index": 1, "op": "replace", "path": "/mode", "value": "single" },
        { "side": "B", "index": 1, "op": "replace", "path": "/mode", "value": "readonly" }
      ],
      "message": "both patches replace the same target with different values (A#1 vs B#1)"
    }
  ]
}
```

其他常用命令：

```bash
curl -s http://localhost:3000/health | jq                 # 健康检查
curl -s http://localhost:3000/api/v1/merges | jq          # 预演记录列表
curl -s http://localhost:3000/api/v1/merges/<id> | jq     # 单条记录（含输入）
curl -s http://localhost:3000/api/v1/merges/<id>/order-audit | jq  # 顺序审计 A→B / B→A
curl -s -X POST http://localhost:3000/api/v1/merges/<id>/resolution-preview \
  -H 'Content-Type: application/json' \
  -d @examples/resolution-preview-request.json | jq       # 冲突解决预览
curl -s http://localhost:3000/api/v1/merges/<id>/round-trip-plan | jq  # forward / rollback 补丁
curl -s http://localhost:3000/api/v1/merges/<id>/provenance | jq       # 叶子来源追踪（base/A/B/both）
curl -s -X POST http://localhost:3000/api/v1/merges/<id>/constraint-preview \
  -H 'Content-Type: application/json' \
  -d @examples/constraint-preview-request.json | jq                    # 条件约束预检（四状态评估 + 违规归因）
curl -s -X POST http://localhost:3000/api/v1/merges/<id>/ownership-preview \
  -H 'Content-Type: application/json' \
  -d @examples/ownership-preview-request.json | jq                     # 路径归属预检（可发布判定 + 违规明细）
curl -s -X POST http://localhost:3000/api/v1/rebases \
  -H 'Content-Type: application/json' \
  -d @examples/rebase-request.json | jq                                # 变基预演（merged + rebasedPatch）
curl -s -X DELETE http://localhost:3000/api/v1/merges/<id> # 删除记录
```

## 合并语义

> 本节描述 `POST /api/v1/merges` 的**基准坐标合并模型**。
> `GET /api/v1/merges/:id/order-audit` 不使用该模型，而是按 **RFC 6902 原生顺序执行**
> 重放（补丁内逐条作用于上一条结果、数组下标不重定位），详见上文「顺序审计」。

### 基准坐标模型

两组补丁中的所有路径都相对**基准文档**解释：数组索引标识的是基准数组中的**原元素**，
而非某个中间结果。服务据此重定位增删造成的索引漂移——例如 A 在 `/servers/0` 前插入、
B 修改 `/servers/2/host`，合并后 B 的修改仍落在基准第 2 号元素上（其新下标可能已变化）。

### 数组

- `add /arr/i`：在**缝隙 i**（基准第 i 号元素之前）插入；`i == 数组长度` 或 `-` 表示追加。
- 同一缝隙的多个插入：先 A 后 B，同侧保持补丁内顺序。
- `remove /arr/i`、`replace /arr/i`：作用于基准第 i 号元素，与其最终下标无关。
- 元素内部的深层修改（如 `/arr/1/host`）跟随元素身份漂移。

### 去重（不产生冲突）

- 双方 `replace` 同一目标且值深度相等 → 应用一次。
- 双方 `remove` 同一目标 → 应用一次。
- 一方删除祖先路径、另一方删除其内部后代 → 后代删除被祖先覆盖，丢弃。
- 双方 `add` 同一个新对象成员且值相等 → 应用一次。

### 冲突类型（返回 `409`）

| `reason` | 含义 |
| --- | --- |
| `delete-vs-modify` | 一方删除某元素/子树，另一方对同一路径或其内部做 `replace`/`add` |
| `replace-mismatch` | 双方 `replace` 同一目标但值不同 |
| `add-mismatch` | 双方 `add` 同一个（基准中不存在的）对象成员但值不同 |
| `replace-overlap` | 一方整体替换某子树，另一方修改其子树内部 |

每条冲突包含：`reason`（原因）、`path`（规范化后的争议路径，RFC 6901 转义）、
`operations`（双方操作的 `side`、`index`（操作序号）、`op`、`path`、`value`）、`message`。

### 补丁内规则（同一补丁）

- 同一路径的多个非插入操作：**后者覆盖前者**（last-wins）；数组插入不去重，按序累积。
- 不允许一个操作的路径是另一个 `add`/`remove`/`replace` 目标的**后代**（返回 `422`），
  数组插入除外（插入不占有子树）。
- 对象成员上的 `add` 若键已存在，按 RFC 6902 规范化为 `replace`。
- 不支持删除文档根（`remove ""`）；`replace ""` 允许整体替换文档。

## 测试

```bash
npm test
```

覆盖：指针转义、索引漂移重定位、同缝隙 A/B 定序、去重规则、全部冲突类型、
非法补丁（`422`）、schema 校验（`400`）、存储的增删查、健康检查，顺序审计的
可交换 / 发散（RFC 6901 字典序最小差异）/ 失败（失败方、原始序号、失败前文档）判定与
重复查询确定性，冲突解决预览的胜方保留 / 败方剔除、覆盖校验（`400`）、
矛盾决定（`422`）、剩余冲突（`409`）、记录不变与重复请求确定性，以及往返补丁计划的
对象字典序与 JSON Pointer 转义、数组 LCS 对齐（删除降序 / 插入升序）、根替换、
前向与回滚重放校验、操作数统计、干净记录可用 / 冲突记录 `409` 且不改记录 / 未知 `404`
与重复请求逐字节一致，以及叶子来源追踪的 base / A / B / both 归属（相同值双边写入）、
后写覆盖与删除后重建的幸存操作归属、数组删除重定位与同缝隙 A/B 定序下的最终指针、
空容器叶子、根替换、路径排序与重复请求逐字节一致，以及变基预演的基准坐标上游转换
（数组 LCS 对齐、未匹配元素删除/插入、连续插入归入同一缝隙）、干净变基的 merged 与
rebasedPatch 重放校验、同缝隙上游优先定序、冲突 `409`（路径/原因/双方序号、无可执行补丁）、
`400`/`422` 输入校验、空补丁与根替换边界、无状态与重复请求逐字节一致，以及条件约束预检的
四状态评估（基准 / A 单独 / B 单独 / 合并结果，单侧沿用基准坐标语义与数组重定位）、
五类违规归因（既存 / A 引入 / B 引入 / 双侧同时 / 仅组合后）、指针存在性与 `null` 值区分、
无效规则 `422`（逐条列出问题）、冲突记录 `409`、未知记录 `404`、记录不变与重复请求逐字节一致，
以及路径归属预检的最长前缀归属（含 RFC 6901 转义与根前缀）、数组插入按父数组归属、
replace/remove/覆盖式 add 的后代规则保护（逐条命中、按前缀排序）、未覆盖路径违规、
原始操作逐条检查（含会被合并丢弃的操作）、冲突记录可用（`200`）、无效规则 `422`、
未知记录 `404`、记录不变与重复请求逐字节一致等。

## 项目结构

```
.
├── server.js                  # 进程入口：读取环境变量、启动与优雅退出
├── src/
│   ├── app.js                 # Fastify 应用：路由、schema 校验、错误处理
│   ├── merge.js               # 合并引擎：规范化 → 补丁内解析 → 跨补丁冲突检测 → 应用
│   ├── audit.js               # 顺序审计：严格 RFC 6902 顺序重放 A→B / B→A、失败捕获、字典序最小差异
│   ├── resolution.js          # 冲突解决预览：胜方决定校验 → 剔除败方 → 复用合并引擎（纯函数，不写存储）
│   ├── roundtrip.js           # 往返补丁：字典序对象 diff + 数组 LCS（删除降序/插入升序）→ RFC 6902 forward/rollback，服务端重放校验
│   ├── provenance.js          # 叶子来源追踪：在带来源标签的镜像文档上重放基准坐标合并，归属 merged 每个叶子（base/A/B/both）
│   ├── constraint.js          # 条件约束预检：规则校验（422）→ 基准/A 单独/B 单独/合并结果四状态评估 → 合并违规归因（既存/A/B/组合）
│   ├── ownership.js           # 路径归属预检：规则校验（422）→ 基准坐标最长前缀归属 → 逐条检查原始操作（数组插入按父数组、后代规则保护）→ 可发布判定
│   ├── rebase.js              # 变基：base→onto 转基准坐标操作（数组 LCS 对齐、缝隙插入）→ 与客户端补丁合并 → 生成并重放校验 onto 相对补丁
│   ├── store.js               # 内存存储（FIFO 淘汰）
│   └── example.js             # 内置示例请求
├── test/                      # node:test 单元 + 集成测试
├── examples/                  # 可直接 curl 的示例请求体
├── Dockerfile                 # 多阶段构建（npm ci 在构建期完成）
└── docker-compose.yml         # 单服务编排 + 健康检查
```

## 说明与限制

- 存储为进程内存，重启即清空；如需持久化可在 `src/store.js` 替换实现。
- 合并是确定性的：同一输入永远产生同一输出（冲突列表按路径与原因排序）。
- 单补丁内操作按基准坐标解释，不做补丁内顺序重放；同路径多操作按 last-wins 处理（见上）。
  若需要「补丁内逐条作用于上一条结果、下标随当前文档漂移」的严格 RFC 6902 语义，
  使用 `GET /api/v1/merges/:id/order-audit`；其结果按记录缓存，重复查询完全一致。
- 往返补丁（`GET /api/v1/merges/:id/round-trip-plan`）由 `base` 与 `merged` 的确定性
  diff 生成（仅 add/remove/replace；数组按 LCS 对齐、删除降序、插入升序），服务端重放
  校验前向与回滚均成立后才返回，并按记录缓存；仅干净合并记录可用，冲突记录返回 `409`。
- 叶子来源追踪（`GET /api/v1/merges/:id/provenance`）在带来源标签的镜像输入上重放同一
  基准坐标合并管线，把 `merged` 每个叶子归属到 `base` / `A` / `B` / `both` 并列出贡献
  操作的原始序号；路径为最终 JSON Pointer，按 UTF-16 码元序排序，结果按记录缓存，
  重复请求逐字节一致；仅干净合并记录可用，冲突记录返回 `409`。
- 条件约束预检（`POST /api/v1/merges/:id/constraint-preview`）把每条「`when` 指针值与
  `equals` 深度相等 ⇒ `require` 指针必须存在」的规则分别评估在基准、A 单独变更、
  B 单独变更与合并结果上：单侧状态由该侧补丁与空补丁按基准坐标语义合并得到（数组按
  基准元素身份重定位），合并结果中的违规按既存 / A 引入 / B 引入 / 仅组合后归因，
  两侧均单独违规时同时标出 A 与 B；预检不修改记录，无效规则返回 `422` 并逐条列出问题，
  冲突记录返回 `409`，仅干净合并记录可用。
- 路径归属预检（`POST /api/v1/merges/:id/ownership-preview`）把每条「`prefix` 子树归
  `owner` 所有」的规则作用于已保存的原始 `patchA` / `patchB`：按基准坐标的最长前缀
  确定每条操作的归属，未被任何规则覆盖或归属另一方即违规；数组插入按父数组路径归属；
  `replace` / `remove`（含覆盖已有对象成员的 `add`）若覆盖到归属另一方的后代规则也
  逐条判违规，防止父节点写入绕过保护。预检不修改记录，干净与冲突记录均可用（不依赖
  `merged`），无效规则返回 `422` 并逐条列出问题，记录不存在返回 `404`。
- 变基（`POST /api/v1/rebases`）是无状态预演：不写内存存储、不返回记录 `id`；`upstream`
  为 `base`→`onto` 的基准坐标操作（数组合并按缝隙寻址，不能直接当顺序补丁执行），
  `rebasedPatch` 才是相对 `onto` 的可执行 RFC 6902 补丁（服务端已重放校验等于 `merged`）；
  冲突时 `rebasedPatch` 为 `null`，只返回结构化冲突。
