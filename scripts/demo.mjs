/**
 * 端到端业务演示：湘超主场票根联动四十余家景区的权益与清算全流程。
 * 运行：npm run demo
 */
import { createApp } from "../src/app.js";

// 可控时钟：离线事件、退票、同步的先后是本演示的关键。
const clock = { t: new Date("2026-09-25T09:00:00+08:00") };
const at = (iso) => (clock.t = new Date(iso));
const advance = (isoMore) => {
  const m = isoMore.match(/^(\d+)h$/);
  clock.t = new Date(clock.t.getTime() + Number(m[1]) * 3_600_000);
};

const app = createApp({ now: () => clock.t });
const { catalog, devices, tickets, benefits, wallet, redemption, sync, appeals, clearing, audit, views, store } = app;
const line = (s) => console.log(`\n${"─".repeat(72)}\n${s}\n${"─".repeat(72)}`);

// 1) 登记四十余家协议山水景区（统一营业窗口：08:00-18:00，全周）。
line("① 目录：1 场湘超主场 + 42 家景区 + 两版权益政策");
const matchId = catalog.scheduleMatch({
  match_code: "XCSL-2026-R7",
  home_team: "永州湘超",
  away_team: "郴州东江",
  kicks_off_at: "2026-10-10T19:30:00+08:00",
  venue: "永州体育中心",
});
const spotIds = [];
const names = ["蘋洲书院", "柳子庙", "浯溪碑林", "阳明山", "舜皇山", "九嶷山", "千家峒", "上甘棠", "勾蓝瑶寨", "李家大院"];
const windows = [{ weekdays: [1, 2, 3, 4, 5, 6, 7], open: "08:00", close: "18:00" }];
for (let i = 1; i <= 42; i++) {
  const id = `spot${String(i).padStart(2, "0")}`;
  spotIds.push(id);
  catalog.registerSpot({
    spot_id: id,
    name: i <= names.length ? names[i - 1] : `联动景区${i}号`,
    windows,
    // 部分山区景区标记为常断网。
    remote_offline_allowed: [4, 5, 6, 7].includes(i),
  });
}

// 政策 v1：允许跨景区重复使用（PER_SPOT），每家 1 次，可带 3 名家庭/同行；赛前 3 天至赛后 7 天。
const policyV1 = catalog.publishPolicy({
  policy_code: "YZ-TICKET-BENEFIT",
  policy_version: 1,
  effective_from: "2026-09-01T00:00:00+08:00",
  effective_to: "2026-10-31T23:59:59+08:00",
  match_window: { relative_to: "KICKOFF", start_offset_hours: -72, end_offset_hours: 168 },
  redemption_scope: "PER_SPOT",
  max_per_spot: 1,
  max_total: 0,
  companions_allowed: true,
  max_companions: 3,
  spot_terms: spotIds.map((spot_id) => ({
    spot_id,
    agreed_price_cents: 4000 + (spot_id.charCodeAt(5) % 5) * 500,
    requires_nomination: false,
  })),
});

// 政策 v2：11 月起改为跨景区去重（GLOBAL），合计 2 次——规则由政策版本决定。
const match2 = catalog.scheduleMatch({
  match_code: "XCSL-2026-FINAL",
  home_team: "永州湘超",
  away_team: "长沙麓山",
  kicks_off_at: "2026-11-08T19:30:00+08:00",
  venue: "永州体育中心",
});
const policyV2 = catalog.publishPolicy({
  policy_code: "YZ-TICKET-BENEFIT",
  policy_version: 2,
  effective_from: "2026-11-01T00:00:00+08:00",
  effective_to: null,
  match_window: { relative_to: "KICKOFF", start_offset_hours: -24, end_offset_hours: 72 },
  redemption_scope: "GLOBAL",
  max_per_spot: 0,
  max_total: 2,
  companions_allowed: false,
  max_companions: 0,
  spot_terms: spotIds.slice(0, 20).map((spot_id) => ({
    spot_id,
    agreed_price_cents: 3500,
    requires_nomination: true,
  })),
});
console.log(`政策 v1=${policyV1}（跨景区可重复）  v2=${policyV2}（跨景区去重，需记名）`);

// 2) 三类票根同时流转：电子票（本人）、纸票（现场记名）、赠票（记名 + 家庭代领）。
line("② 出票：电子票 / 纸票 / 赠票，权益随票按 v1 授予");
const elec = tickets.confirmTicket({
  match_session_id: matchId, serial: "EL-2026-0001", media: "ELECTRONIC",
  holder_key: "fan-li", policy_id: policyV1,
});
const paper = tickets.confirmTicket({
  match_session_id: matchId, serial: "PA-2026-0088", media: "PAPER",
  holder_key: "paper-0088", policy_id: policyV1,
});
tickets.nominateTicket(paper.ticket_id, { holder_key: "zhang-paper" });
const comp = tickets.confirmTicket({
  match_session_id: matchId, serial: "CP-2026-0007", media: "COMPLIMENTARY",
  holder_key: "comp-0007", policy_id: policyV1,
});
tickets.nominateTicket(comp.ticket_id, { holder_key: "wang-family" });
const family = benefits.linkCompanion(comp.account_id, { person_key: "wang-spouse", relationship: "FAMILY" });
console.log("电子票账户", elec.account_id, "｜纸票记名账户", paper.account_id, "｜赠票账户", comp.account_id);
console.log("家庭成员（可代领）令牌", family.person_token);

// 断网山区景区（spot04/spot05）的闸机须在赛前联网预置登记，之后方可断网核销。
const dev04 = devices.registerDevice({ spot_id: "spot04", offline_quota: 20 });
const dev05a = devices.registerDevice({ spot_id: "spot05", offline_quota: 10 });
const dev05b = devices.registerDevice({ spot_id: "spot05", offline_quota: 10 });
// 在线景区设备。
const dev01 = devices.registerDevice({ spot_id: "spot01", offline_quota: 0 });
const dev02 = devices.registerDevice({ spot_id: "spot02", offline_quota: 0 });
const dev03 = devices.registerDevice({ spot_id: "spot03", offline_quota: 0 });
const dev06 = devices.registerDevice({ spot_id: "spot06", offline_quota: 0 });

// 3) 同日多点游览（PER_SPOT 政策允许跨景区重复使用）。
line("③ 10-11 同日多点游览：电子票在 spot01、spot02 分别核销，均成功");
at("2026-10-11T10:05:00+08:00");
let voucher = wallet.issueVoucher(elec.account_id);
let r1 = redemption.redeemVoucher({ device_id: dev01.device_id, spot_id: "spot01", voucher });
let r2 = redemption.redeemVoucher({ device_id: dev02.device_id, spot_id: "spot02", voucher });
console.log("spot01：", r1.status, r1.price_cents ?? r1.rule_detail);
console.log("spot02：", r2.status, r2.price_cents ?? r2.rule_detail);

// 同一景区再来一次：额度已用完，拒绝并给出规则版本与依据。
let r3 = redemption.redeemVoucher({ device_id: dev01.device_id, spot_id: "spot01", voucher });
console.log("spot01 再刷：", r3.status, "｜原因", r3.reason_code, "｜依据版本", r3.policy_id);
console.log("  依据原文：", r3.rule_detail);

// 4) 家庭代领：配偶在 spot03 用赠票家庭权益入园。
line("④ 家庭代领：配偶持家庭凭证在 spot03 入园");
const familyVoucher = wallet.issueVoucher(comp.account_id, { person_token: family.person_token });
const r4 = redemption.redeemVoucher({ device_id: dev03.device_id, spot_id: "spot03", voucher: familyVoucher });
console.log("spot03 家庭核销：", r4.status, "关系", r4.relationship);

// 5) 山水景区断网：spot04 离线签发待同步凭证（10-12 上午）。
line("⑤ 断网：spot04 山区景区 10-12 10:00 离线核销电子票（待同步）");
at("2026-10-12T10:00:00+08:00");
const term04 = app.offlineTerminal(dev04.device_id, { clock: () => clock.t });
voucher = wallet.issueVoucher(elec.account_id);
const off = term04.scan(voucher);
console.log("离线结果：", off.status, "设备序号", off.device_seq, "凭证", off.proof_id);

// 6) 赛后退票（10-12 下午）：只冻结尚未消费的权利。
line("⑥ 10-12 15:00 赛后退票：已核销的 spot01/02/04 不受影响");
at("2026-10-12T15:00:00+08:00");
tickets.refundTicket(elec.ticket_id, { reason: "行程变更，赛后申请退票" });
const afterRefund = redemption.redeemVoucher({ device_id: dev02.device_id, spot_id: "spot02", voucher });
console.log("退票后在新景区核销：", afterRefund.status, afterRefund.reason_code);

// 7) 联网同步：按“发生时间”合并——10:00 的离线核销早于 15:00 退票，仍然成立。
line("⑦ 10-13 恢复联网：离线凭证按发生时间合并，早于退票的核销有效");
at("2026-10-13T09:00:00+08:00");
const syncRes = sync.syncBundle(term04.exportBundle());
console.log("合并成功", syncRes.captured.length, "笔，作废", syncRes.voided.length, "笔，拒绝", syncRes.rejected.length, "笔");

// 8) 跨设备双花：spot05 两台设备同时断网刷同一家庭账户（该景区额度仅 1）。
//    山区闸机在赛前已预置登记（真实部署约束：先登记、后断网核销）。
line("⑧ 跨设备竞争：spot05 两台断网设备刷同一权利项，时间线后者被冲正");
// 设备 dev05a/dev05b 已在赛前预置登记。
const t5a = app.offlineTerminal(dev05a.device_id);
const t5b = app.offlineTerminal(dev05b.device_id);
const compVoucher = wallet.issueVoucher(comp.account_id);
t5a.scan(compVoucher, { at: new Date("2026-10-11T14:00:00+08:00") });
t5b.scan(compVoucher, { at: new Date("2026-10-11T14:00:30+08:00") });
// 合并发生在恢复联网后的 10-13（设备登记早于核销，时点模型可识别设备）。
const sa = sync.syncBundle(t5a.exportBundle());
const sb = sync.syncBundle(t5b.exportBundle());
console.log("设备A：", sa.captured.length, "捕获 /", sa.voided.length, "作废");
console.log("设备B：", sb.captured.length, "捕获 /", sb.voided.length, "作废（", sb.voided[0]?.reason_code, "）");

// 游客就被冲正凭证提交证据申诉（以赠票账户当前持票人身份）。
const holderToken = holderOf(app, comp.account_id);
const appeal = appeals.fileAppeal({
  account_id: comp.account_id,
  person_token: holderToken,
  subject_type: "VOIDED_PENDING",
  subject_event_id: store.eventsByType("REDEMPTION_VOIDED").at(-1)?.event_id,
  statement: "两台闸机同排入园，确属本人一次游览，申请补回 spot05 权益",
  evidence: [{ kind: "PHOTO", content: "gate-photo-bytes" }, { kind: "RECEIPT", content: "parking-receipt" }],
});
console.log("申诉已提交：", appeal.appeal_id, "（证据仅留存指纹）");

// 9) 临时闭园：闭园期间核销拒绝，引用政策版本。
line("⑨ 景区临时闭园：spot06 10-15 全天闭园，核销被拒（SPOT_CLOSED）");
catalog.closeSpot("spot06", {
  from: "2026-10-15T00:00:00+08:00",
  to: "2026-10-15T23:59:59+08:00",
  reason: "山洪预警",
});
at("2026-10-15T10:00:00+08:00");
const closedVoucher = wallet.issueVoucher(paper.account_id);
const rc = redemption.redeemVoucher({ device_id: dev06.device_id, spot_id: "spot06", voucher: closedVoucher });
console.log("闭园核销：", rc.status, "｜", rc.rule_detail);

// 申诉支持：补回游客权益（用真实持票令牌）。
line("⑩ 申诉处理：双花冲正经核实予以支持，补权 1 次");
const resolve = appeals.resolveAppeal(appeal.appeal_id, {
  decision: "UPHELD",
  resolved_by: "文旅联动办公室",
  resolution: "双机同刻确属一次游览，冲正后补回 spot05 权益 1 次",
  grant: { quota_grants: [{ person_token: comp.account_id && holderOf(app, comp.account_id), spot_id: "spot05", amount: 1 }] },
});
console.log("申诉决定：", resolve.decision, "补权事件", resolve.adjustment_event_id);

// 10) 11 月新政策（GLOBAL 去重、需记名）：第三家景区被拒。
line("⑪ 政策 v2（跨景区去重）：合计 2 次，第三家景区核销拒绝");
at("2026-11-08T10:30:00+08:00");
const t2 = tickets.confirmTicket({
  match_session_id: match2, serial: "EL-FINAL-0009", media: "ELECTRONIC",
  holder_key: "fan-li", policy_id: policyV2,
});
const v2voucher = wallet.issueVoucher(t2.account_id);
const d20 = devices.registerDevice({ spot_id: "spot20", offline_quota: 0 });
const g1 = redemption.redeemVoucher({ device_id: d20.device_id, spot_id: "spot20", voucher: v2voucher });
const d19 = devices.registerDevice({ spot_id: "spot19", offline_quota: 0 });
const g2 = redemption.redeemVoucher({ device_id: d19.device_id, spot_id: "spot19", voucher: wallet.issueVoucher(t2.account_id) });
const d18 = devices.registerDevice({ spot_id: "spot18", offline_quota: 0 });
const g3 = redemption.redeemVoucher({ device_id: d18.device_id, spot_id: "spot18", voucher: wallet.issueVoucher(t2.account_id) });
console.log("spot20：", g1.status, "｜spot19：", g2.status, "｜spot18：", g3.status, g3.reason_code ?? "");
console.log("  拒绝依据：", g3.rule_detail);

// 11) 月末清算：批次归集、逐笔补贴、一笔冲正、关闭批次。
line("⑫ 十月清算批次：逐笔入账（非截图），冲正 1 笔，关闭并汇总");
at("2026-10-31T23:30:00+08:00");
const batch = clearing.openBatch({
  period_from: "2026-10-01T00:00:00+08:00",
  period_to: "2026-10-31T23:59:59+08:00",
});
const settled = clearing.settleBatch(batch);
console.log(`批次 ${batch} 入账 ${settled.length} 笔`);
const fraudEntry = settled.find((s) => s.entry_id);
const reverse = clearing.reverseEntry(fraudEntry.entry_id, {
  reason_code: "FRAUD",
  note: "复核发现该笔为冒用记名信息，冲正补贴",
  restoreQuota: false,
});
const closed = clearing.closeBatch(batch);
console.log("冲正：", reverse.reversed_cents, "分");
console.log("批次汇总：应收", closed.total_cents, "冲正", closed.reversal_cents, "净额", closed.net_cents, "（分）");

// 12) 主管部门：从一笔补贴回查全链路。
line("⑬ 主管部门补贴追溯：票务真实状态 / 核销设备 / 政策版本 / 后续调整");
const trace = audit.traceEntry(
  settled.find((s) => s.entry_id !== fraudEntry.entry_id).entry_id,
);
console.log(JSON.stringify({
  补贴: trace.subsidy,
  票根: trace.ticket,
  设备: trace.device,
  政策版本: trace.policy && { id: trace.policy.policy_id, scope: trace.policy.redemption_scope, version: trace.policy.policy_version },
  离线来源: trace.offline_origin,
  后续调整: trace.later_adjustments,
  申诉: trace.appeals,
}, null, 2));

// 13) 隐私：景区只见本景区假名；清算只见计价假名；游客见全量自有信息。
line("⑭ 隐私分级：spot01 看不到其他景区行程；清算侧无票号身份");
const spot01View = views.spotView("spot01");
const spotSeesSpots = new Set(spot01View.redemptions.map((r) => r.proof_id)).size;
console.log("spot01 可见核销笔数：", spot01View.redemptions.length, "（全部 spot01 假名）",
  "示例人假名：", spot01View.redemptions[0]?.person_ref);
const clearingView = views.clearingView(batch);
console.log("清算侧示例：", JSON.stringify(clearingView.entries[0], null, 2));
const visitor = views.visitorView(holderOf(app, elec.account_id));
console.log("游客可见账户数：", visitor.accounts.length, "｜退票冻结标记：", JSON.stringify(visitor.accounts[0].frozen));
console.log("游客剩余权益（已退票，应全部冻结展示）：",
  JSON.stringify(visitor.accounts[0].benefits.slice(0, 3)));
console.log("游客可见拒绝记录数：", visitor.accounts[0].rejections.length);

console.log("\n演示完成：领域事件共", store.size, "条。");

function holderOf(application, accountId) {
  // 从事件里取账户当前持票令牌（演示辅助）。
  const grant = application.store
    .eventsByType("BENEFIT_GRANTED", "BENEFIT_ADJUSTED")
    .filter((e) => e.aggregate_id === accountId && e.payload?.holder_token);
  return grant.at(-1)?.payload?.holder_token;
}
