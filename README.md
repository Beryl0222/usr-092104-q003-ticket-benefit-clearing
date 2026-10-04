# 赛事票根权益清算后端

永州把湘超主场票根扩展为四十余家景区的免票凭证。本仓库在领域事件约定之上，交付**票根权益与清算后端**：
把比赛场次、票务状态、权益政策版本、持有人/同行关系、景区营业窗口、核销凭证、异常申诉、结算批次
关联成一条可回查、可冲正、保护隐私的事件链。财政补贴基于不可变事件而非截图。

零第三方依赖（Node 内置 `node:crypto` / `node:http` / `node:test`）。

## 业务规则落点

| 需求 | 实现 |
| --- | --- |
| 纸票 / 电子票 / 赠票同时流转 | `TICKET_CONFIRMED`（`media`），电子票购票即记名，纸票/赠票现场 `TICKET_NOMINATED` |
| 权益政策与生效期、按版本判定 | `POLICY_PUBLISHED` 不可变版本，同代码生效区间不得重叠；核销/拒绝都记录所依据的 `policy_id` |
| **政策化**跨景区复用，不一刀切去重 | 政策 `redemption_scope`：`PER_SPOT` 每家分别计数（可同日多点）；`GLOBAL` 全部景区合计去重 |
| 家庭代领 / 同行 | `BENEFIT_COMPANION_LINKED`（`FAMILY`/`GUEST`），人数受政策上限约束，成员各有独立额度 |
| 景区营业窗口 / 临时闭园 | `SPOT_REGISTERED` / `SPOT_WINDOWS_UPDATED` / `SPOT_CLOSED`，按北京时间周历判定 |
| 山水景区断网核销 | 离线终端验签 + 逐景区加密凭证，本地签发 `REDEMPTION_PENDING`（设备签名 + 设备序号） |
| 联网后合并 | 按**业务发生时间 + 设备身份 + 设备序号**在时点读模型上重放；幂等；跨设备竞争后到者 `REDEMPTION_VOIDED` |
| 转赠 / 退款 / 延期 / 闭园只影响未消费权利 | `BENEFIT_ADJUSTED`/`BENEFIT_REVOKED` 只动剩余额度与窗口；已消费核销与清算不回滚 |
| 游客知情、可申诉 | 游客视图给出各景区剩余权益、每次拒绝的规则版本与逐条依据、作废与申诉状态；证据只存指纹 |
| 景区追踪待结算/冲正 | 景区视图含 `PENDING_SETTLEMENT` 金额与 `reversals` |
| 主管部门补贴回查 | `audit.traceEntry`：补贴 → 核销事件 → 设备 → 政策版本 → 票务真实状态 → 后续调整/冲正/申诉 |
| 隐私：行程不暴露给无关景区 | 逐景区 AES-GCM 加密凭证条目 + 景区专属假名；景区只见本景区、无法跨景区串联 |
| 清算侧最小知情 | 清算视图只有金额、政策版本、设备、清算假名与票介质；无票号、无身份、无行程 |

## 目录

- `contracts/domain.schema.json`：事件信封、25 类事件、10 类聚合与载荷约定。
- `src/domain.ts`：事件与枚举的 TypeScript 类型。
- `src/validator.js`：事件信封/枚举/聚合匹配校验。
- `src/kernel/`：事件存储、时钟与营业窗口、不透明标识与设备签名、逐景区加密、分级假名、离线凭证。
- `src/projections/read-model.js`：全局读模型与时点读模型（离线按发生时间重放的基础）。
- `src/services/`：目录、设备、票务、权益、钱包、核销、离线终端、同步、申诉、清算、审计追溯。
- `src/views/views.js`：游客 / 景区 / 清算三类隐私分级视图（主管部门视图在 `audit-service`）。
- `src/app.js`：装配根；`src/http-server.js`：HTTP 接口。
- `scripts/demo.mjs`：覆盖全链路的端到端演示。
- `tests/`：契约、政策核销、离线合并、票务生命周期、申诉清算隐私。

## 快速开始

```bash
npm test     # 24 项场景测试
npm run demo # 端到端演示（42 家景区 / 三种票 / 断网 / 退票 / 双花 / 闭园 / 两版政策 / 清算追溯）
npm run serve # 启动 HTTP 后端（默认 :8080）
```

## HTTP 角色

请求头 `x-client-role`：`ticketing`、`office`（文旅联动办/主管部门）、`spot`（景区终端）、
`visitor`（游客 App）、`clearing`（财政清算）、`device-gateway`（离线同步网关）。
路由与角色映射见 `src/http-server.js`；生产应替换为网关鉴权与密钥管理。

## 关键事件流

```
MATCH_SCHEDULED ─┐
POLICY_PUBLISHED ┼─ TICKET_CONFIRMED ─┬─ BENEFIT_GRANTED ─┬─ BENEFIT_COMPANION_LINKED
SPOT_REGISTERED  │                    ├─ TICKET_NOMINATED ┤   (转赠/延期/闭园/申诉 → BENEFIT_ADJUSTED)
DEVICE_REGISTERED┘                   ├─ TICKET_TRANSFERRED┤   (退款/作废 → BENEFIT_REVOKED)
                                     └─ TICKET_REFUNDED ─┘
                                            │
      在线：REDEMPTION_CAPTURED / REDEMPTION_REJECTED
      离线：REDEMPTION_PENDING ─(同步)→ REDEMPTION_CAPTURED / REDEMPTION_VOIDED
                                            │
            CLEARING_BATCH_OPENED → CLAIM_SETTLED（每笔补贴，冻结计价快照）
                                            └─ ENTRY_REVERSED（负数冲正，可选回补权益）
                  申诉：APPEAL_FILED → APPEAL_RESOLVED →（支持时）BENEFIT_ADJUSTED / ENTRY_REVERSED
```

更详细的设计见 [docs/architecture.md](docs/architecture.md)。
