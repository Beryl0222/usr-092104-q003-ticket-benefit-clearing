import test from "node:test";
import assert from "node:assert/strict";

import { setupWorld, registerStandardCatalog, registerDevice } from "./helpers.js";
import { holderToken } from "../src/kernel/pseudonyms.js";

function secretOf(app) {
  return app.secrets.tokenSecret;
}

test("转赠：只转移尚未消费的权利，已消费的景区额度不随转赠补回", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-TX-1", media: "ELECTRONIC", holder_key: "alice", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);
  const d02 = registerDevice(app, spotIds[1]);

  setClock("2026-10-11T10:00:00+08:00");
  // Alice 在 spot01 已消费 1 次
  app.redemption.redeem({ device_id: d01.device_id, spot_id: spotIds[0], person_token: holderToken(secretOf(app), "alice") });

  // 转赠给 Bob：spot01 剩余 0 不转移，spot02 剩余 1 转移。
  app.tickets.transferTicket(t.ticket_id, { holder_key: "bob" });
  const bobToken = holderToken(secretOf(app), "bob");
  const aliceToken = holderToken(secretOf(app), "alice");

  // Bob 在 spot02 可以用（未消费权利已转移）
  const bobSpot02 = app.redemption.redeem({ device_id: d02.device_id, spot_id: spotIds[1], person_token: bobToken });
  assert.equal(bobSpot02.status, "CAPTURED");

  // Bob 在 spot01 不能用：Alice 已消费，额度不会因转赠而补回
  const bobSpot01 = app.redemption.redeem({ device_id: d01.device_id, spot_id: spotIds[0], person_token: bobToken });
  assert.equal(bobSpot01.status, "REJECTED");
  assert.equal(bobSpot01.reason_code, "QUOTA_USED");

  // 隐私：受让方只看到自己的核销，看不到前手 Alice 在 spot01 的历史行程。
  const bobView = app.views.visitorView(bobToken).accounts[0];
  assert.deepEqual(bobView.history.map((h) => h.spot_id), [spotIds[1]]);
  assert.equal(bobView.history.some((h) => h.spot_id === spotIds[0]), false);
  const bobSpot01Benefit = bobView.benefits.find((b) => b.spot_id === spotIds[0]);
  assert.equal(bobSpot01Benefit.remaining, 0);

  // Alice 旧令牌不再持有未消费权利（spot02 已转走），但仍可查本人历史。
  const aliceView = app.views.visitorView(aliceToken).accounts[0];
  assert.equal(aliceView.benefits.find((b) => b.spot_id === spotIds[1]).remaining, 0);
  assert.deepEqual(aliceView.history.map((h) => h.spot_id), [spotIds[0]]);
});

test("赛后退票：冻结尚未消费权利，已核销部分照常进入清算", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-RF-1", media: "ELECTRONIC", holder_key: "carol", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);
  const d02 = registerDevice(app, spotIds[1]);

  setClock("2026-10-11T10:00:00+08:00");
  app.redemption.redeem({ device_id: d01.device_id, spot_id: spotIds[0], person_token: holderToken(secretOf(app), "carol") });

  setClock("2026-10-12T15:00:00+08:00");
  app.tickets.refundTicket(t.ticket_id);

  // 未消费的 spot02 不能再核销
  const blocked = app.redemption.redeem({ device_id: d02.device_id, spot_id: spotIds[1], person_token: holderToken(secretOf(app), "carol") });
  assert.equal(blocked.reason_code, "TICKET_REFUNDED");

  // 已核销的 spot01 仍可结算
  setClock("2026-10-31T12:00:00+08:00");
  const batch = app.clearing.openBatch({ period_from: "2026-10-01T00:00:00+08:00", period_to: "2026-10-31T23:59:59+08:00" });
  const settled = app.clearing.settleBatch(batch);
  assert.equal(settled.length, 1, "已消费核销不受退票影响，照常补贴");
});

test("比赛延期：权益窗口平移，未消费权利在新窗口可用，已核销不回滚", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-PP-1", media: "ELECTRONIC", holder_key: "dave", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);

  // 原定开赛 10-10，窗口到 10-17（+168h）。先在 10-11 消费一次。
  setClock("2026-10-11T10:00:00+08:00");
  app.redemption.redeem({ device_id: d01.device_id, spot_id: spotIds[0], person_token: holderToken(secretOf(app), "dave") });

  // 延期 7 天
  app.tickets.postponeMatch(match, { new_kicks_off_at: "2026-10-17T19:30:00+08:00", reason: "天气" });

  // 用另一景区 spot02 验证窗口平移：10-20 对原窗口已超期，对新窗口仍有效
  const d02 = registerDevice(app, spotIds[1]);
  setClock("2026-10-20T10:00:00+08:00");
  const r = app.redemption.redeem({ device_id: d02.device_id, spot_id: spotIds[1], person_token: holderToken(secretOf(app), "dave") });
  assert.equal(r.status, "CAPTURED", "窗口应随开赛平移");

  const view = app.views.visitorView(holderToken(secretOf(app), "dave")).accounts[0];
  assert.equal(view.history.length, 2, "已核销记录不回滚");
});

test("家庭代领：FAMILY 成员可在政策额度内入园，GUEST 同理；超人数被拒", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  const t = app.tickets.confirmTicket({
    match_session_id: match, serial: "CP-FAM-1", media: "COMPLIMENTARY", holder_key: "fam", policy_id: policy,
  });
  app.tickets.nominateTicket(t.ticket_id, { holder_key: "fam-head" });
  const spouse = app.benefits.linkCompanion(t.account_id, { person_key: "spouse", relationship: "FAMILY" });
  const friend = app.benefits.linkCompanion(t.account_id, { person_key: "friend", relationship: "GUEST" });

  const d03 = registerDevice(app, spotIds[2]);
  setClock("2026-10-11T10:00:00+08:00");
  const rs = app.redemption.redeem({ device_id: d03.device_id, spot_id: spotIds[2], person_token: spouse.person_token });
  const rf = app.redemption.redeem({ device_id: d03.device_id, spot_id: spotIds[2], person_token: friend.person_token });
  assert.equal(rs.status, "CAPTURED");
  assert.equal(rf.status, "CAPTURED", "同行人各自有独立额度");

  // 第 4 个同伴超出 max_companions=3（含配偶、朋友共 2 人，还能加 1 人，第 2 个新增即超限）
  app.benefits.linkCompanion(t.account_id, { person_key: "kid", relationship: "FAMILY" });
  assert.throws(
    () => app.benefits.linkCompanion(t.account_id, { person_key: "guest2", relationship: "GUEST" }),
    /上限/,
  );
});

test("无关联人员令牌无法使用他人权益", () => {
  const { app, setClock } = setupWorld();
  const { match, spotIds, policy } = registerStandardCatalog(app);
  app.tickets.confirmTicket({
    match_session_id: match, serial: "EL-X-1", media: "ELECTRONIC", holder_key: "owner", policy_id: policy,
  });
  const d01 = registerDevice(app, spotIds[0]);
  setClock("2026-10-11T10:00:00+08:00");
  const r = app.redemption.redeem({ device_id: d01.device_id, spot_id: spotIds[0], person_token: holderToken(secretOf(app), "stranger") });
  assert.equal(r.reason_code, "RELATIONSHIP_DENIED");
});
