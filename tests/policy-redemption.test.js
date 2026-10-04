import test from "node:test";
import assert from "node:assert/strict";

import { setupWorld, registerStandardCatalog, registerDevice } from "./helpers.js";

test("PER_SPOT 政策允许跨景区重复使用、同日多点游览，但同一景区额度受限", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app, { scope: "PER_SPOT" });
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-1", media: "ELECTRONIC", holder_key: "u1", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);
  const d02 = registerDevice(app, spotIds[1]);

  setClock("2026-10-11T10:00:00+08:00");
  const v = app.wallet.issueVoucher(t.account_id);
  const r1 = app.redemption.redeemVoucher({ device_id: d01.device_id, spot_id: spotIds[0], voucher: v });
  const r2 = app.redemption.redeemVoucher({ device_id: d02.device_id, spot_id: spotIds[1], voucher: v });
  assert.equal(r1.status, "CAPTURED");
  assert.equal(r2.status, "CAPTURED", "不同景区分别计数，不应一刀切去重");

  const r3 = app.redemption.redeemVoucher({
    device_id: d01.device_id, spot_id: spotIds[0], voucher: app.wallet.issueVoucher(t.account_id),
  });
  assert.equal(r3.status, "REJECTED");
  assert.equal(r3.reason_code, "QUOTA_USED");
});

test("GLOBAL 政策跨景区合计去重：第三次在别的景区被拒", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app, { scope: "GLOBAL" });
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-2", media: "ELECTRONIC", holder_key: "u2", policy_id: policy,
  });
  const devices = spotIds.slice(0, 3).map((s) => registerDevice(app, s));

  setClock("2026-10-11T10:00:00+08:00");
  const r1 = app.redemption.redeemVoucher({ device_id: devices[0].device_id, spot_id: spotIds[0], voucher: app.wallet.issueVoucher(t.account_id) });
  const r2 = app.redemption.redeemVoucher({ device_id: devices[1].device_id, spot_id: spotIds[1], voucher: app.wallet.issueVoucher(t.account_id) });
  const r3 = app.redemption.redeemVoucher({ device_id: devices[2].device_id, spot_id: spotIds[2], voucher: app.wallet.issueVoucher(t.account_id) });
  assert.equal(r1.status, "CAPTURED");
  assert.equal(r2.status, "CAPTURED");
  assert.equal(r3.status, "REJECTED");
  assert.equal(r3.reason_code, "QUOTA_USED");
  assert.match(r3.rule_detail, /跨景区去重/);
});

test("每次拒绝都记录所依据的政策版本与逐条理由", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app, { scope: "PER_SPOT" });
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-3", media: "ELECTRONIC", holder_key: "u3", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);

  setClock("2026-10-25T10:00:00+08:00"); // 超出 -72h/+168h 窗口
  const r = app.redemption.redeemVoucher({
    device_id: d01.device_id, spot_id: spotIds[0], voucher: app.wallet.issueVoucher(t.account_id),
  });
  assert.equal(r.status, "REJECTED");
  assert.equal(r.reason_code, "OUTSIDE_WINDOW");
  assert.equal(r.policy_id, policy, "拒绝必须指明判定所用政策版本");
  assert.match(r.rule_detail, /P-STD v1/);
});

test("景区临时闭园期间拒绝并给出闭园依据；恢复后可用", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app, { scope: "PER_SPOT" });
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-4", media: "ELECTRONIC", holder_key: "u4", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);

  app.catalog.closeSpot(spotIds[0], {
    from: "2026-10-15T00:00:00+08:00", to: "2026-10-15T23:59:59+08:00", reason: "山洪预警",
  });
  setClock("2026-10-15T10:00:00+08:00");
  const closed = app.redemption.redeemVoucher({
    device_id: d01.device_id, spot_id: spotIds[0], voucher: app.wallet.issueVoucher(t.account_id),
  });
  assert.equal(closed.reason_code, "SPOT_CLOSED");
  assert.match(closed.rule_detail, /山洪预警/);

  setClock("2026-10-16T10:00:00+08:00");
  const open = app.redemption.redeemVoucher({
    device_id: d01.device_id, spot_id: spotIds[0], voucher: app.wallet.issueVoucher(t.account_id),
  });
  assert.equal(open.status, "CAPTURED");
});

test("要求记名的景区：未记名纸票被拒，记名后当前持票人凭证通过", () => {
  const { app, setClock } = setupWorld();
  const { catalog } = app;
  const match = catalog.scheduleMatch({
    match_code: "M-N", home_team: "H", away_team: "A",
    kicks_off_at: "2026-10-10T19:30:00+08:00", venue: "v",
  });
  catalog.registerSpot({ spot_id: "spotN1", name: "需记名景区", windows: [{ weekdays: [1, 2, 3, 4, 5, 6, 7], open: "08:00", close: "18:00" }] });
  const policy = catalog.publishPolicy({
    policy_code: "P-N", policy_version: 1,
    effective_from: "2026-09-01T00:00:00+08:00", effective_to: null,
    match_window: { relative_to: "KICKOFF", start_offset_hours: -72, end_offset_hours: 168 },
    redemption_scope: "PER_SPOT", max_per_spot: 1, max_total: 0,
    companions_allowed: false, max_companions: 0,
    spot_terms: [{ spot_id: "spotN1", agreed_price_cents: 3000, requires_nomination: true }],
  });
  const dev = app.devices.registerDevice({ spot_id: "spotN1", offline_quota: 0 });
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "PA-N-1", media: "PAPER", holder_key: "paper-seed", policy_id: policy,
  });

  setClock("2026-10-11T10:00:00+08:00");
  const before = app.redemption.redeemVoucher({
    device_id: dev.device_id, spot_id: "spotN1", voucher: app.wallet.issueVoucher(t.account_id),
  });
  assert.equal(before.reason_code, "NOT_NOMINATED");

  app.tickets.nominateTicket(t.ticket_id, { holder_key: "real-name" });
  // 记名后账户当前持票人已更新，重新签发的凭证走记名持票人。
  const after = app.redemption.redeemVoucher({
    device_id: dev.device_id, spot_id: "spotN1", voucher: app.wallet.issueVoucher(t.account_id),
  });
  assert.equal(after.status, "CAPTURED");
});
