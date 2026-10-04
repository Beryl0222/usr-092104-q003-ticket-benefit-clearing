import test from "node:test";
import assert from "node:assert/strict";

import { setupWorld, registerStandardCatalog, registerDevice } from "./helpers.js";

function issueTicket(app, match, policy, serial, holder_key = "u1", media = "ELECTRONIC") {
  return app.tickets.confirmTicket({ match_session_id: match, serial, media, holder_key, policy_id: policy });
}

test("离线凭证：断网签发，联网后按发生时间合并，早于退票仍有效", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = issueTicket(app, match, policy, "EL-OFF-1");
  const d04 = registerDevice(app, spotIds[3], 20);

  // 10-12 上午断网核销
  setClock("2026-10-12T10:00:00+08:00");
  const terminal = app.offlineTerminal(d04.device_id, { clock: () => new Date("2026-10-12T10:00:00+08:00") });
  const scan = terminal.scan(app.wallet.issueVoucher(t.account_id));
  assert.equal(scan.status, "PENDING");

  // 同日下午赛后退票
  setClock("2026-10-12T15:00:00+08:00");
  app.tickets.refundTicket(t.ticket_id, { reason: "赛后申请退票" });

  // 次日联网同步
  setClock("2026-10-13T09:00:00+08:00");
  const res = app.sync.syncBundle(terminal.exportBundle());
  assert.equal(res.captured.length, 1, "发生在退票之前的离线核销必须仍然成立");
  assert.equal(res.rejected.length, 0);

  const model = app.store.eventsByType("REDEMPTION_CAPTURED");
  const captured = model.find((e) => e.payload.channel === "OFFLINE_SYNC");
  assert.equal(captured.payload.occurred_on_device_at, "2026-10-12T02:00:00.000Z");
  assert.ok(captured.payload.synced_at, "应记录同步时间");
});

test("离线凭证发生在退票之后：合并时拒绝（只影响尚未消费的权利）", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = issueTicket(app, match, policy, "EL-OFF-2");
  const d = registerDevice(app, spotIds[0], 20);

  // 游客在断网/退票之前就已领取凭证。
  setClock("2026-10-12T10:00:00+08:00");
  const voucher = app.wallet.issueVoucher(t.account_id);

  // 同日下午赛后退票
  setClock("2026-10-12T15:00:00+08:00");
  app.tickets.refundTicket(t.ticket_id);

  // 终端本地时钟：退票之后才尝试入园（终端离线不知道已退票，仍签发待同步凭证）
  const terminal = app.offlineTerminal(d.device_id);
  const scan = terminal.scan(voucher, {
    at: new Date("2026-10-12T16:00:00+08:00"),
  });
  assert.equal(scan.status, "PENDING");

  setClock("2026-10-13T09:00:00+08:00");
  const res = app.sync.syncBundle(terminal.exportBundle());
  assert.equal(res.captured.length, 0);
  assert.equal(res.rejected.length, 1);
  assert.equal(res.rejected[0].reason_code, "TICKET_REFUNDED");
});

test("跨设备同一权利项竞争：按发生时间排序，后到者 DOUBLE_SPEND 可申诉", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = issueTicket(app, match, policy, "EL-OFF-3");
  const da = registerDevice(app, spotIds[4], 10);
  const db = registerDevice(app, spotIds[4], 10);
  const ta = app.offlineTerminal(da.device_id);
  const tb = app.offlineTerminal(db.device_id);
  const voucher = app.wallet.issueVoucher(t.account_id);

  ta.scan(voucher, { at: new Date("2026-10-11T14:00:00+08:00") });
  tb.scan(voucher, { at: new Date("2026-10-11T14:00:30+08:00") });

  setClock("2026-10-13T09:00:00+08:00");
  const ra = app.sync.syncBundle(ta.exportBundle());
  const rb = app.sync.syncBundle(tb.exportBundle());
  assert.equal(ra.captured.length, 1);
  assert.equal(rb.voided.length, 1);
  assert.equal(rb.voided[0].reason_code, "DOUBLE_SPEND");

  // 被冲正凭证在游客视图中可申诉
  const holder = currentHolder(app, t.account_id);
  const view = app.views.visitorView(holder);
  const voided = view.accounts[0].voided;
  assert.equal(voided.length, 1);
  assert.equal(voided[0].can_appeal, true);
});

test("同一凭证重复同步幂等，不重复入账", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = issueTicket(app, match, policy, "EL-OFF-4");
  const d = registerDevice(app, spotIds[0], 10);
  const terminal = app.offlineTerminal(d.device_id);
  terminal.scan(app.wallet.issueVoucher(t.account_id), { at: new Date("2026-10-11T11:00:00+08:00") });
  const bundle = terminal.exportBundle();

  setClock("2026-10-13T09:00:00+08:00");
  const first = app.sync.syncBundle(bundle);
  const second = app.sync.syncBundle(bundle);
  assert.equal(first.captured.length, 1);
  assert.equal(second.captured.length, 1);
  assert.equal(second.captured[0].idempotent_replay, true);
  assert.equal(app.store.eventsByType("REDEMPTION_CAPTURED").length, 1);
});

test("设备绑定景区不符：在线核销直接拒绝 DEVICE_SPOT_MISMATCH", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = issueTicket(app, match, policy, "EL-OFF-5");
  const d = registerDevice(app, spotIds[0]);
  setClock("2026-10-11T10:00:00+08:00");
  const r = app.redemption.redeemVoucher({
    device_id: d.device_id, spot_id: spotIds[1], voucher: app.wallet.issueVoucher(t.account_id),
  });
  assert.equal(r.status, "REJECTED");
  assert.equal(r.reason_code, "DEVICE_SPOT_MISMATCH");
});

test("离线设备额度耗尽后拒绝并留痕 OFFLINE_QUOTA_EXCEEDED", () => {
  const { app } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = issueTicket(app, match, policy, "EL-OFF-6");
  const d = registerDevice(app, spotIds[0], 1); // 仅允许 1 笔离线
  const terminal = app.offlineTerminal(d.device_id);
  const voucher = app.wallet.issueVoucher(t.account_id);
  const r1 = terminal.scan(voucher, { at: new Date("2026-10-11T10:00:00+08:00") });
  assert.equal(r1.status, "PENDING");
  // 第二个不同账户也无法在该设备离线签发（设备额度，与游客额度无关）
  const t2 = issueTicket(app, match, policy, "EL-OFF-7", "u2");
  const r2 = terminal.scan(app.wallet.issueVoucher(t2.account_id), { at: new Date("2026-10-11T10:05:00+08:00") });
  assert.equal(r2.status, "REJECTED_OFFLINE");
  assert.equal(r2.reason_code, "OFFLINE_QUOTA_EXCEEDED");
});

function currentHolder(application, accountId) {
  return application.store
    .eventsByType("BENEFIT_GRANTED", "BENEFIT_ADJUSTED")
    .filter((e) => e.aggregate_id === accountId && e.payload?.holder_token)
    .at(-1).payload.holder_token;
}
