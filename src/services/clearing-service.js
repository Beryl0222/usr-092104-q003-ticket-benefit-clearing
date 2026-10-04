/**
 * 财政清算服务。
 * - 月末按批次归集已核销凭证：每笔补贴生成 CLAIM_SETTLED，冻结计价快照（金额+政策版本+票务状态），
 *   财政凭事件而非截图补贴；
 * - 冲正 ENTRY_REVERSED 记负数并可回补游客权益；景区可见待结算与被冲正记录；
 * - 批次关闭时汇总应收/冲正/净额。
 */
import { randomId } from "../kernel/ids.js";
import { iso, isBetween } from "../kernel/clock.js";
import { buildReadModel } from "../projections/read-model.js";

export function createClearingService({ store, benefitService, now = () => new Date() }) {
  const rm = () => buildReadModel(store);

  function openBatch({ period_from, period_to, opened_by = "clearing-office" }) {
    const batchId = randomId("batch");
    store.commit([
      {
        event_type: "CLEARING_BATCH_OPENED",
        aggregate_type: "clearing_batch",
        aggregate_id: batchId,
        occurred_at: iso(now()),
        summary: `开启清算批次：${period_from} 至 ${period_to}`,
        payload: { period_from, period_to, opened_by },
      },
    ]);
    return batchId;
  }

  /**
   * 将批次周期内已核销、尚未在任何批次结算的凭证逐笔入账。
   * 只结算 CAPTURED 且未被冲正的凭证；每条分录可回查核销事件、设备与政策版本。
   */
  function settleBatch(batchId) {
    const model = rm();
    const batch = model.batches.get(batchId);
    if (!batch) throw new Error(`批次不存在：${batchId}`);
    if (batch.status !== "OPEN") throw new Error("批次已关闭，不能再入账");

    const settled = [];
    for (const proof of model.proofs.values()) {
      if (proof.status !== "CAPTURED") continue;
      if (!isBetween(proof.occurred_on_device_at, batch.period_from, batch.period_to)) continue;
      if (model.entryByRedemption.has(proof.captured_event_id)) continue; // 已在册（未冲正）
      if (alreadySettledEver(model, proof.captured_event_id)) continue; // 曾结算并被冲正，不重复入账

      const ticket = model.tickets.get(model.accounts.get(proof.account_id)?.ticket_id);
      const entryId = randomId("entry");
      const [event] = store.commit([
        {
          event_type: "CLAIM_SETTLED",
          aggregate_type: "clearing_entry",
          aggregate_id: entryId,
          occurred_at: iso(now()),
          summary: `${proof.spot_id} 补贴入账 ${proof.agreed_price_cents} 分（核销 ${proof.id}）`,
          payload: {
            batch_id: batchId,
            spot_id: proof.spot_id,
            redemption_event_id: proof.captured_event_id,
            account_id: proof.account_id,
            policy_id: proof.policy_id,
            amount_cents: proof.agreed_price_cents,
            priced_at: iso(now()),
            // 清算侧只需计价与核验锚点：票的不透明 ID、介质、计价时状态快照；
            // 票号、持票人等身份信息不在清算事件中出现，主管部门凭 ticket_id 回查。
            ticket_id: model.accounts.get(proof.account_id)?.ticket_id ?? null,
            ticket_status_snapshot: ticket?.status ?? "UNKNOWN",
            ticket_media: ticket?.media ?? null,
            device_id: proof.device_id,
            channel: proof.channel,
            occurred_on_device_at: proof.occurred_on_device_at,
          },
        },
      ]);
      settled.push({ entry_id: entryId, event_id: event.event_id, amount_cents: proof.agreed_price_cents });
    }
    return settled;
  }

  /**
   * 冲正一笔在账分录（申诉属实/欺诈/双花/重新计价）。
   * @param restoreQuota 是否同时向实际入园人回补 1 次权益
   */
  function reverseEntry(entryId, { reason_code, upstream_event_id = "", note = "", restoreQuota = false }) {
    const model = rm();
    const entry = model.entries.get(entryId);
    if (!entry) throw new Error(`清算分录不存在：${entryId}`);
    if (entry.status === "REVERSED") throw new Error("分录已冲正");

    const drafts = [];
    if (restoreQuota) {
      const proof = [...model.proofs.values()].find((x) => x.captured_event_id === entry.redemption_event_id);
      if (proof) {
        const account = model.accounts.get(proof.account_id);
        const policy = model.policies.get(account.policy_id);
        const spotId = policy.redemption_scope === "GLOBAL" ? null : proof.spot_id;
        const adjustmentId = randomId("evt");
        drafts.push({
          event_type: "BENEFIT_ADJUSTED",
          aggregate_type: "benefit_account",
          aggregate_id: proof.account_id,
          event_id: adjustmentId,
          occurred_at: iso(now()),
          summary: `冲正回补权益 1 次（${reason_code}）`,
          payload: {
            reason_code: "APPEAL_GRANTED",
            quota_grants: [{ person_token: proof.person_token, spot_id: spotId, amount: 1 }],
            upstream_event_id,
          },
        });
      }
    }
    drafts.push({
      event_type: "ENTRY_REVERSED",
      aggregate_type: "clearing_entry",
      aggregate_id: entryId,
      occurred_at: iso(now()),
      summary: `冲正 ${entry.spot_id} 补贴 ${entry.amount_cents} 分（${reason_code}）`,
      payload: {
        batch_id: entry.batch_id,
        original_entry_id: entryId,
        reason_code,
        amount_cents: -Math.abs(entry.amount_cents),
        upstream_event_id,
        quota_restored: restoreQuota,
        note,
      },
    });
    store.commit(drafts, { correlationId: `reverse_${entryId}` });
    return { entry_id: entryId, reversed_cents: -Math.abs(entry.amount_cents), quota_restored: restoreQuota };
  }

  function closeBatch(batchId, { closed_by = "clearing-office" } = {}) {
    const model = rm();
    const batch = model.batches.get(batchId);
    if (!batch) throw new Error(`批次不存在：${batchId}`);
    if (batch.status !== "OPEN") throw new Error("批次已关闭");

    let total_cents = 0;
    let reversal_cents = 0;
    let entry_count = 0;
    for (const entryId of batch.entry_ids) {
      const entry = model.entries.get(entryId);
      if (!entry) continue;
      total_cents += entry.amount_cents;
      entry_count += 1;
      if (entry.status === "REVERSED") reversal_cents += entry.reversal.amount_cents; // 负数
    }
    const closedAt = iso(now());
    store.commit([
      {
        event_type: "CLEARING_BATCH_CLOSED",
        aggregate_type: "clearing_batch",
        aggregate_id: batchId,
        occurred_at: closedAt,
        summary: `批次关闭：应收 ${total_cents}，冲正 ${reversal_cents}，净额 ${total_cents + reversal_cents}（分）`,
        payload: {
          total_cents,
          reversal_cents,
          net_cents: total_cents + reversal_cents,
          entry_count,
          closed_at: closedAt,
          closed_by,
        },
      },
    ]);
    return { batch_id: batchId, total_cents, reversal_cents, net_cents: total_cents + reversal_cents, entry_count };
  }

  return { openBatch, settleBatch, reverseEntry, closeBatch };
}

function alreadySettledEver(model, redemptionEventId) {
  for (const entry of model.entries.values()) {
    if (entry.redemption_event_id === redemptionEventId) return true;
  }
  return false;
}
