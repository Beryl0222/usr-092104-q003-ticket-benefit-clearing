import test from "node:test";
import assert from "node:assert/strict";

import { setupWorld, registerStandardCatalog, registerDevice } from "./helpers.js";
import { holderToken } from "../src/kernel/pseudonyms.js";

const s = (app) => app.secrets.tokenSecret;

test("申诉闭环：提交证据 -> 支持 -> 补权，事件可关联回查", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-AP-1", media: "ELECTRONIC", holder_key: "g", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);

  setClock("2026-10-11T10:00:00+08:00");
  const rejected = app.redemption.redeem({
    device_id: d01.device_id, spot_id: spotIds[0], person_token: holderToken(s(app), "nobody"),
  });
  // 先用真实持票人制造一次可申诉拒绝（闭园），更贴合业务
  app.catalog.closeSpot(spotIds[1], {
    from: "2026-10-12T00:00:00+08:00", to: "2026-10-12T23:59:59+08:00", reason: "道路中断",
  });
  setClock("2026-10-12T10:00:00+08:00");
  const d02 = registerDevice(app, spotIds[1]);
  const denial = app.redemption.redeem({
    device_id: d02.device_id, spot_id: spotIds[1], person_token: holderToken(s(app), "g"),
  });
  assert.equal(denial.reason_code, "SPOT_CLOSED");

  const holder = holderToken(s(app), "g");
  const appeal = app.appeals.fileAppeal({
    account_id: t.account_id,
    person_token: holder,
    subject_type: "CLOSURE_LOSS",
    subject_event_id: denial.event_id,
    statement: "专程前往因闭园无法入园，申请补一次权益",
    evidence: [{ kind: "PHOTO", content: "proof-bytes" }],
  });

  const resolution = app.appeals.resolveAppeal(appeal.appeal_id, {
    decision: "UPHELD",
    resolved_by: "联动办",
    resolution: "闭园属实，补 spot02 权益 1 次",
    grant: { quota_grants: [{ person_token: holder, spot_id: spotIds[1], amount: 1 }] },
  });
  assert.ok(resolution.adjustment_event_id);

  // 闭园补偿后即便景区恢复，spot02 也可再用（总额度 +1，此前未消费）
  setClock("2026-10-13T10:00:00+08:00");
  const again = app.redemption.redeem({ device_id: d02.device_id, spot_id: spotIds[1], person_token: holder });
  assert.equal(again.status, "CAPTURED");
  void rejected;
});

test("清算：逐笔计价入账、冲正记负数、批次净额正确，景区可见待结算与冲正", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-CL-1", media: "ELECTRONIC", holder_key: "h", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);
  const d02 = registerDevice(app, spotIds[1]);
  setClock("2026-10-11T10:00:00+08:00");
  app.redemption.redeem({ device_id: d01.device_id, spot_id: spotIds[0], person_token: holderToken(s(app), "h") });
  app.redemption.redeem({ device_id: d02.device_id, spot_id: spotIds[1], person_token: holderToken(s(app), "h") });

  // 结算前景区有待结算金额
  const before = app.views.spotView(spotIds[0]);
  assert.equal(before.pending_settlement_cents, 5000);

  setClock("2026-10-31T12:00:00+08:00");
  const batch = app.clearing.openBatch({ period_from: "2026-10-01T00:00:00+08:00", period_to: "2026-10-31T23:59:59+08:00" });
  const entries = app.clearing.settleBatch(batch);
  assert.equal(entries.length, 2);

  app.clearing.reverseEntry(entries[0].entry_id, { reason_code: "FRAUD", note: "复核异常" });
  const closed = app.clearing.closeBatch(batch);
  assert.equal(closed.total_cents, 10000);
  assert.equal(closed.reversal_cents, -5000);
  assert.equal(closed.net_cents, 5000);

  // 景区视图出现被冲正记录
  const after = app.views.spotView(spotIds[0]);
  assert.equal(after.reversals.length, 1);
  assert.equal(after.reversals[0].amount_cents, -5000);
});

test("主管部门可从每笔补贴回查票务状态、核销设备、政策版本与后续冲正", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-AU-1", media: "ELECTRONIC", holder_key: "aud", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);
  setClock("2026-10-11T10:00:00+08:00");
  app.redemption.redeem({ device_id: d01.device_id, spot_id: spotIds[0], person_token: holderToken(s(app), "aud") });
  setClock("2026-10-12T15:00:00+08:00");
  app.tickets.refundTicket(t.ticket_id); // 赛后退票（核销在先）

  setClock("2026-10-31T12:00:00+08:00");
  const batch = app.clearing.openBatch({ period_from: "2026-10-01T00:00:00+08:00", period_to: "2026-10-31T23:59:59+08:00" });
  const entries = app.clearing.settleBatch(batch);
  const trace = app.audit.traceEntry(entries[0].entry_id);

  assert.equal(trace.ticket.current_status, "REFUNDED", "回查得到真实票务状态（退票发生在核销后）");
  assert.equal(trace.ticket.media, "ELECTRONIC");
  assert.equal(trace.device.bound_spot_id, spotIds[0]);
  assert.equal(trace.policy.policy_version, 1);
  assert.equal(trace.policy.redemption_scope, "PER_SPOT");
  assert.ok(trace.later_adjustments.some((a) => a.event_type === "BENEFIT_REVOKED"));
  // 补贴金额与核销事件锚点齐备
  assert.equal(trace.subsidy.amount_cents, 5000);
  assert.ok(trace.redemption.event_id);
});

test("隐私：景区只见本景区假名，清算侧只见计价假名，且两者不互通", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-PR-1", media: "ELECTRONIC", holder_key: "priv", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);
  const d02 = registerDevice(app, spotIds[1]);
  setClock("2026-10-11T10:00:00+08:00");
  app.redemption.redeem({ device_id: d01.device_id, spot_id: spotIds[0], person_token: holderToken(s(app), "priv") });
  app.redemption.redeem({ device_id: d02.device_id, spot_id: spotIds[1], person_token: holderToken(s(app), "priv") });

  setClock("2026-10-31T12:00:00+08:00");
  const batch = app.clearing.openBatch({ period_from: "2026-10-01T00:00:00+08:00", period_to: "2026-10-31T23:59:59+08:00" });
  app.clearing.settleBatch(batch);

  const v01 = app.views.spotView(spotIds[0]);
  const v02 = app.views.spotView(spotIds[1]);
  // 每个景区只看到自己的 1 笔，看不到另一景区行程
  assert.equal(v01.redemptions.length, 1);
  assert.equal(v02.redemptions.length, 1);
  // 同一游客在两景区的人假名不同，景区间无法串联
  assert.notEqual(v01.redemptions[0].person_ref, v02.redemptions[0].person_ref);
  assert.match(v01.redemptions[0].person_ref, /spot01/);
  assert.match(v02.redemptions[0].person_ref, /spot02/);

  // 清算侧只见计价假名，不见票号/全局令牌
  const cv = app.views.clearingView(batch);
  assert.ok(cv.entries[0].visitor_ref.startsWith("tk_clearing_"));
  assert.equal(cv.entries[0].ticket_serial, undefined);
  // 清算假名 != 任一景区假名
  for (const e of cv.entries) {
    assert.notEqual(e.visitor_ref, v01.redemptions[0].person_ref);
    assert.notEqual(e.visitor_ref, v02.redemptions[0].person_ref);
  }

  // 游客本人视图可见全部景区行程
  const visitor = app.views.visitorView(holderToken(s(app), "priv"));
  assert.equal(visitor.accounts[0].history.length, 2);
});
