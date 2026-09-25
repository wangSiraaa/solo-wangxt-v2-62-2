# RSVP 事件账本（可追溯排座系统）

两家人分别用各自的**离线表格**持续补录 RSVP。系统把每一次变更作为**不可变事件**追加到账本，
同时维护一份可随时重建的**当前物化状态**。自动排座**只给候选、绝不移动席位**。

零外部依赖，Node.js ≥ 20。

## 核心语义

### 1. 事件账本是唯一事实来源

每条事件带：

| 字段 | 含义 |
| --- | --- |
| `eventNo` | 全局稳定事件号，只增不复用 |
| `guestId` | 宾客标识 |
| `source` | 来源（如 `family-a` / `family-b`）；`migration`、`manual-resolution` 为系统保留 |
| `sourceSeq` | **来源内序号**（该离线表格自己的行号/版本号） |
| `occurredAt` | 事情发生时间（离线表格中填写的时间） |
| `recordedAt` | 系统记账时间 |
| `stale` / `supersededBy` | 乱序旧事件留痕标记及覆盖它的事件号 |

物化状态 `guests[].rsvp` 只由账本推导，可随时 `rebuildMaterialized` 完整重建。
事件账本与物化状态在**同一次原子写**中落盘。

### 2. 幂等：同一来源的重复事件

幂等键 = `(source, sourceSeq)`。

- 同键同内容（状态/人数/儿童/童椅指纹一致）→ **重复跳过**：不分配事件号、不改变状态、不重复占座；
  因此同一份 CSV 导入任意多次结果完全相同。
- 同键**不同内容** → `REPLAY_CONFLICT`（非法顺序/篡改），**整批拒绝**。

### 3. 乱序：迟到旧事件只留痕

同一来源内以 `sourceSeq` 最大者为最新（**不依赖导入顺序，也不依赖 occurredAt**）。

- 晚到的小序号事件照常入账，但标记 `stale=true`、`supersededBy=<新事件号>`；
- 物化状态仍取最新事件 —— 旧婉拒不会回滚后来的确认/待定，反之亦然。

### 4. 跨来源冲突：显式待人工处理

不同来源对同一宾客的最新状态不一致时：

- 物化状态取**确定性回退值**（来源名字典序最小），仅用于占位显示；
- 宾客被显式标记 `conflict`，并**被排除出自动排座**；
- 无论两个来源谁先导入，结果完全一致（不靠导入顺序静默覆盖）；
- 人工在界面/CLI 裁决后写入一条 `manual-resolution` 事件；裁决后任一来源再出现新状态，
  冲突自动重新挂起（裁决不会被当作永久静默）。

### 5. 排座边界：只出候选，不动席位

- `autoCandidates` 只处理**未入座**且状态明确（confirmed、无冲突、人数有效）的宾客；
- **锁定席永不移动、永不被候选占用逻辑破坏**；
- 强制保留：锁定席、每桌容量、**儿童椅容量**、同桌组（传递闭包，整组同进同出）、避让关系；
- 已入座宾客变为婉拒/待定/冲突：进入**受影响清单**与待处理；锁定席 `manualOnly`，只登记不腾座；
- `applyPlan` 只能落“当下仍有效的新候选”，任何移动既有席位的请求都会被拒绝。

### 6. 整批导入的事务性

预检所有行（未知宾客、非法状态/人数/童椅/时间/序号、重放冲突、缺列），
**任一行非法 → 整批拒绝**：内存与磁盘上的账本、物化状态、席位、桌卡全部不变。

## 快速开始

```bash
# 旧系统数据迁移（v1 JSON 或 v1 CSV → v2 账本）
node src/cli.js migrate --from examples/v1-export.csv --to data/store.json

# 基础数据
node src/cli.js table add --id T2 --name 次桌 --capacity 8 --child-capacity 4
node src/cli.js guest add --id G04 --name 赵六
node src/cli.js relation same G02 G04     # 同桌
node src/cli.js relation avoid G01 G04    # 避让

# 两家人各自导入（可反复导、乱序导）
node src/cli.js import --file examples/family-a.csv
node src/cli.js import --file examples/family-b.csv

node src/cli.js status        # 物化状态
node src/cli.js events        # 事件账本
node src/cli.js conflicts     # 待人工处理的跨来源冲突
node src/cli.js resolve --guest G04 --source family-a --note 电话核实
node src/cli.js review        # 受影响清单 + 新自动候选（不动席位）
node src/cli.js apply --items G03@T1,G05+G06@T2   # 人工确认后才落座
node src/cli.js lock   --guest G01
node src/cli.js unlock --guest G01

# 导出
node src/cli.js export-ledger --out ledger.csv   # 含 stale/superseded_by 留痕列
node src/cli.js export-state  --out state.csv    # 桌卡/席位视图

# Web 界面（宾客历史 / 影响提示 / 冲突裁决 / 候选 / 导入导出）
node src/cli.js serve --port 8080
```

导入 CSV 列：

```
source,source_seq,guest_id,status,party_size,children,child_seat,occurred_at
```

`source` 列可省略（用 `--source family-a` 或界面上的默认来源补全）；
`status ∈ confirmed|pending|declined`。

## 目录

```
src/lib/store.js       存储结构/原子写/账本重建
src/lib/events.js      事件追加、幂等、乱序留痕、冲突与裁决、宾客历史
src/lib/seating.js     候选生成、影响评估、约束校验、人工应用
src/lib/migrate.js     v1 → v2 本地迁移
src/lib/importexport.js 批量 CSV 导入（整批事务）与账本/状态导出
src/cli.js             命令行
src/server.js          本地 HTTP API
public/index.html      宾客历史/影响提示界面
test/                  node:test 验收测试（17 个）
```

## 测试

```bash
npm test
```

验收场景覆盖：刷新后最新确认仍入候选、重复导入不重复占座、乱序旧婉拒不回滚、
锁定席婉拒只入待处理、未知宾客/非法顺序整批失败且桌卡不变、跨来源冲突顺序无关与裁决失效、
同桌/避让/儿童椅约束保留、迁移保留锁定席与关系。
