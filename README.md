# RSVP 事件账本（可追溯 / 两来源补录 / 排座边界）

把"两家人各自的离线表格持续补录 RSVP"建模为 **只追加事件流**：事件账本是唯一事实来源，
当前 RSVP 状态由账本确定性物化得到，席位是独立的物化状态。零第三方依赖，Node.js ≥ 18。

## 核心规则

1. **每条事件可追溯**：稳定事件号 `E000001…`（按追加顺序分配、不复用）、`guestId`、
   `source`（来源，如 `family_zhang`）、`seq`（来源内序号）、`occurredAt`（发生时间）、
   `receivedAt`（到账时间）。
2. **同源幂等**：同一 `(source, seq)` 重复导入且内容一致 → 识别为重复跳过，不重复入账、不重复占座；
   同序号内容不同 → 视为篡改，整批拒绝。
3. **迟到旧事件只留痕**：物化按 `occurredAt` 排序，较新事实生效；后到账的旧事件标记为
   `superseded` + `late`，**不会回滚**后来的确认/待定/婉拒。结果与导入顺序无关。
4. **跨来源冲突不静默覆盖**：同一时刻、不同来源给出不同内容 → 双方标 `conflicted`，
   当前值标记为暂定（`statusProvisional`），进入待人工队列；系统不选边。可人工 `resolve`
   （落一条 `manual/resolution` 事件）；之后到达更晚的新事实也会自动解除冲突，冲突仅留痕。
5. **整批事务**：未知宾客、非法状态/时间、序号跳号/非正整数、批内重复、缺列等 → 整批失败，
   账本、来源游标、席位与桌卡均不变。
6. **排座只给方案不动席位**：RSVP 变化**绝不**自动移动任何席位，只输出受影响清单 + 新候选；
   自动排座仅纳入"名录内、已确认、无冲突、当前未排座"宾客，候选必须人工批准；
   **锁定席、儿童椅、同桌组、避让关系**在方案与物化中全部保留，无法满足时列入 `unsatisfiable`。
   锁定席宾客婉拒 → 只进入待处理；释放必须先显式解锁。

## 目录结构

```
src/
  model/constants.js      状态/效果常量、中英文状态归一
  util/time.js            时间解析与全序键
  util/csv.js             CSV 解析/序列化
  storage.js              JSON/JSONL 原子持久化
  migrate.js              本地迁移 + 旧版扁平表迁移
  domain/
    events.js             事件号分配、事件构造
    import.js             纯校验 planImport + 事务提交 commitImport
    materializer.js       账本 -> 当前状态/宾客历史/冲突（与导入顺序无关）
    reference.js          名录、桌台、同桌组(连通分量)、避让对
    seating.js            影响分析、自动候选（纯计算）、席位显式操作
  export.js               账本/状态/历史/全量导出
  app.js                  服务层（事务编排、审计、冲突裁决）
  server.js               零依赖 Web API + 控制台
bin/rsvp.js               CLI
web/                      单页控制台（待处理/历史/导入/排座/导出）
test/                     node --test 验收测试
examples/                 导入模板 + 端到端演示
```

## 快速开始

```bash
node bin/rsvp.js init --home ./data
node bin/rsvp.js guest add --id G001 --name 张三 --home ./data
node bin/rsvp.js table add --id T1 --name 主桌 --capacity 10 --home ./data
node bin/rsvp.js import --source family_zhang --file examples/rsvp-import-template.csv --home ./data
node bin/rsvp.js status --home ./data
node bin/rsvp.js review --home ./data       # 待人工处理总览
node bin/rsvp.js impact --home ./data       # RSVP 变化对已排座宾客的影响
node bin/rsvp.js propose --home ./data      # 自动候选（不落数据）
node bin/rsvp.js seat apply --home ./data   # 人工批准后才写席位
node bin/rsvp.js export ledger --out ledger.csv --home ./data
```

或直接跑端到端演示：

```bash
node examples/seed-demo.js /tmp/demo-home
RSVP_HOME=/tmp/demo-home node bin/rsvp.js review
RSVP_HOME=/tmp/demo-home node src/server.js   # http://localhost:4173
```

旧版扁平表迁移（幂等）：

```bash
node bin/rsvp.js legacy-migrate --file old-rsvp.csv --home ./data
```

## 导入 CSV 格式

`guestId,status,occurredAt,seq[,partySize,note]`

- `status`：`confirmed/pending/declined` 或 `确认/待定/婉拒`（兼容 yes/no/maybe/tentative 等）。
- `occurredAt`：ISO 8601（建议 UTC，如 `2026-09-20T10:00:00Z`）。
- `seq`：**该来源内**的正整数序号，从 1 开始、连续追加；不同来源各自独立计数。
- `guestId` 必须已存在于名录；`manual` 为系统保留来源，外部不得使用。

## 宾客历史效果标记

| effect | 含义 |
| --- | --- |
| `applied` | 当前生效的最新事实 |
| `superseded` | 被更晚事实覆盖（含迟到旧事件、已被后续事实解决的旧冲突），仅留痕 |
| `convergent` | 跨来源同刻且内容一致的冗余记录 |
| `conflicted` | 跨来源同刻内容不一致，待人工处理 |
| `late`（布尔） | 发生时间更早、却更晚到账（迟到旧事件） |

## HTTP API（`src/server.js`）

- `GET /api/snapshot`：统计、物化状态、席位、影响清单、待处理、最近导入批次
- `GET /api/proposal` / `GET /api/impact` / `GET /api/guest/:id`
- `GET /api/ledger.csv` / `GET /api/state.csv`
- `POST /api/import` `{source, csvText}`；`POST /api/resolve`；
  `POST /api/seat/{assign,lock,unlock,release,apply-proposal}`；`POST /api/guest`、`POST /api/table`

## 测试

```bash
node --test test/
```

覆盖验收点：

1. 最新确认刷新后仍可进入候选；
2. 重复导入不重复占座；
3. 乱序旧婉拒不回滚后来的确认（且与导入顺序无关）；
4. 锁定席宾客婉拒只进待处理、席位不动；
5. 未知宾客/非法顺序整批失败，且原事件、席位、桌卡不受影响；

另含跨来源冲突与人工裁决、儿童椅/同桌/避让/容量边界、旧表迁移与 CSV 往返、事件号稳定性。
