/**
 * 隐私分级读视图。同一事件存储，按角色投影出不同字段：
 * - 游客视图（本人令牌）：完整自有权益、全景区行程、每次拒绝的规则版本与依据、申诉状态；
 * - 景区视图（景区身份）：仅本景区核销/待结算/被冲正，用本景区假名，看不到身份与其他景区行程；
 * - 清算视图（财政）：只取核验与计价所需（金额、政策版本、设备、清算假名），不含票号与行程；
 * - 主管部门视图：见 audit-service，凭授权可全链路回查。
 */
import { buildReadModel } from "../projections/read-model.js";
import { spotAccountPseudonym, spotPersonPseudonym, clearingPseudonym } from "../kernel/pseudonyms.js";

export function createViews({ store, tokenSecret }) {
  /** 游客视图：传入本人不透明持票/成员令牌。 */
  function visitorView(personToken) {
    const model = buildReadModel(store);
    const accounts = [];
    for (const account of model.accounts.values()) {
      if (!account.persons.has(personToken)) continue;
      const policy = model.policies.get(account.policy_id);
      const ticket = model.tickets.get(account.ticket_id);
      const match = model.matches.get(ticket?.match_session_id);
      const person = account.persons.get(personToken);

      const benefits = [];
      const frozen = account.revoked
        ? { reason_code: account.revoked.reason_code, since: account.revoked.at }
        : null;
      const usable = (remaining) => (frozen ? 0 : remaining);
      if (policy.redemption_scope === "GLOBAL") {
        const globalUsed = [...model.proofs.values()].filter(
          (x) => x.status === "CAPTURED" && x.account_id === account.id && x.person_token === personToken,
        ).length;
        const total = person.terms.filter((t) => t.spot_id === null).reduce((s, t) => s + t.total, 0);
        benefits.push({
          spot_id: null,
          spot_name: "全部协议景区合计（跨景区去重）",
          used: globalUsed,
          remaining: usable(Math.max(0, total - globalUsed)),
          usable: !frozen,
        });
      } else {
        for (const term of policy.spot_terms) {
          const spot = model.spots.get(term.spot_id);
          const used = [...model.proofs.values()].filter(
            (x) =>
              x.status === "CAPTURED" &&
              x.account_id === account.id &&
              x.person_token === personToken &&
              x.spot_id === term.spot_id,
          ).length;
          const total = person.terms
            .filter((t) => t.spot_id === term.spot_id)
            .reduce((s, t) => s + t.total, 0);
          benefits.push({
            spot_id: term.spot_id,
            spot_name: spot?.name ?? term.spot_id,
            used,
            remaining: usable(Math.max(0, total - used)),
            agreed_price_cents: term.agreed_price_cents,
            usable: !frozen,
          });
        }
      }

      const myProofs = [...model.proofs.values()].filter(
        (x) => x.account_id === account.id && x.person_token === personToken,
      );
      const history = myProofs
        .filter((x) => x.status === "CAPTURED")
        .map((x) => ({
          spot_id: x.spot_id,
          spot_name: model.spots.get(x.spot_id)?.name ?? x.spot_id,
          at: x.occurred_on_device_at,
          channel: x.channel,
          policy_id: x.policy_id,
        }))
        .sort((a, b) => new Date(b.at) - new Date(a.at));

      const rejections = myProofs
        .filter((x) => x.status === "REJECTED")
        .map((x) => ({
          proof_id: x.id,
          spot_id: x.spot_id,
          at: x.occurred_on_device_at,
          reason_code: x.reason_code,
          policy_id: x.policy_id,
          rule_detail: x.rule_detail,
          can_appeal: true,
        }));

      const voided = myProofs
        .filter((x) => x.status === "VOIDED")
        .map((x) => ({
          proof_id: x.id,
          spot_id: x.spot_id,
          at: x.occurred_on_device_at,
          reason_code: x.void_reason,
          note: x.void_note,
          can_appeal: true,
        }));

      const appeals = [...model.appeals.values()]
        .filter((a) => a.account_id === account.id && a.person_token === personToken)
        .map((a) => ({
          appeal_id: a.id,
          status: a.status,
          subject_type: a.subject_type,
          subject_event_id: a.subject_event_id,
          decision: a.status === "OPEN" ? null : a.decision,
          resolution: a.resolution ?? null,
        }));

      accounts.push({
        account_id: account.id,
        relationship: person.relationship,
        is_holder: account.holder_token === personToken,
        ticket_media: ticket?.media ?? null,
        match: match ? { match_code: match.match_code, kicks_off_at: match.kicks_off_at, status: match.status } : null,
        policy: {
          policy_id: policy.id,
          policy_code: policy.policy_code,
          policy_version: policy.policy_version,
          redemption_scope: policy.redemption_scope,
          cross_spot_reusable: policy.redemption_scope === "PER_SPOT",
        },
        window: account.window,
        frozen: account.revoked
          ? { reason_code: account.revoked.reason_code, since: account.revoked.at }
          : null,
        benefits,
        history,
        rejections,
        voided,
        appeals,
      });
    }
    return { person_token: personToken, accounts };
  }

  /** 景区视图：仅本景区数据，使用本景区假名。 */
  function spotView(spotId) {
    const model = buildReadModel(store);
    const spot = model.spots.get(spotId);
    if (!spot) throw new Error(`景区不存在：${spotId}`);

    const redemptions = [...model.proofs.values()]
      .filter((x) => x.spot_id === spotId)
      .map((x) => {
        if (x.status === "CAPTURED") {
          const entry = model.entryByRedemption.get(x.captured_event_id);
          const entryObj = entry ? model.entries.get(entry) : null;
          return {
            proof_id: x.id,
            person_ref: x.person_ref, // 本景区专属假名
            relationship: x.relationship,
            at: x.occurred_on_device_at,
            channel: x.channel,
            device_id: x.device_id,
            policy_id: x.policy_id,
            status: "CAPTURED",
            settlement: entryObj
              ? {
                  entry_id: entryObj.id,
                  batch_id: entryObj.batch_id,
                  amount_cents: entryObj.amount_cents,
                  state: entryObj.status, // SETTLED / REVERSED
                }
              : { state: "PENDING_SETTLEMENT" },
          };
        }
        return null;
      })
      .filter(Boolean);

    const reversals = [...model.entries.values()]
      .filter((e) => e.spot_id === spotId && e.status === "REVERSED")
      .map((e) => ({
        entry_id: e.id,
        batch_id: e.batch_id,
        amount_cents: e.reversal.amount_cents,
        reason_code: e.reversal.reason_code,
        at: e.reversal.at,
      }));

    const pendingTotal = [...model.proofs.values()]
      .filter((x) => x.status === "CAPTURED" && x.spot_id === spotId)
      .filter((x) => !model.entryByRedemption.has(x.captured_event_id))
      .reduce((s, x) => s + (x.agreed_price_cents ?? 0), 0);

    return {
      spot: { spot_id: spot.id, name: spot.name, remote_offline_allowed: spot.remote_offline_allowed },
      windows: spot.windows,
      closures: spot.closures,
      redeemed_count: redemptions.length,
      pending_settlement_cents: pendingTotal,
      redemptions,
      reversals,
    };
  }

  /** 清算视图：脱敏计价信息，按批次/景区汇总。 */
  function clearingView(batchId) {
    const model = buildReadModel(store);
    const batch = model.batches.get(batchId);
    if (!batch) throw new Error(`批次不存在：${batchId}`);
    const entries = batch.entry_ids.map((id) => {
      const e = model.entries.get(id);
      const proof = [...model.proofs.values()].find((x) => x.captured_event_id === e.redemption_event_id);
      return {
        entry_id: e.id,
        spot_id: e.spot_id,
        visitor_ref: clearingPseudonym(tokenSecret, e.account_id), // 清算专用假名
        amount_cents: e.status === "REVERSED" ? 0 : e.amount_cents,
        state: e.status,
        policy_id: e.policy_id,
        device_id: e.device_id,
        channel: e.channel,
        occurred_at: e.occurred_on_device_at,
        ticket_media: e.ticket_media,
        ticket_status_at_pricing: e.ticket_status_snapshot,
        reversal: e.status === "REVERSED"
          ? { amount_cents: e.reversal.amount_cents, reason_code: e.reversal.reason_code }
          : null,
      };
    });
    const bySpot = new Map();
    for (const e of entries) {
      const cur = bySpot.get(e.spot_id) ?? { spot_id: e.spot_id, gross_cents: 0, reversal_cents: 0, count: 0 };
      cur.gross_cents += e.amount_cents;
      cur.reversal_cents += e.reversal?.amount_cents ?? 0;
      cur.count += 1;
      bySpot.set(e.spot_id, cur);
    }
    return {
      batch_id: batch.id,
      status: batch.status,
      period: { from: batch.period_from, to: batch.period_to },
      totals: batch.totals ?? null,
      by_spot: [...bySpot.values()].map((s) => ({ ...s, net_cents: s.gross_cents + s.reversal_cents })),
      entries,
    };
  }

  return { visitorView, spotView, clearingView };
}
