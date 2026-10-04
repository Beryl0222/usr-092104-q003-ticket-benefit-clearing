/**
 * 补贴追溯（主管部门视图，全链路）。
 * 从每笔补贴分录回查：核销事件与设备、票务真实状态、适用政策版本、
 * 离线同步来源、后续冲正与申诉/补权——每一环都是不可变事件。
 */
import { buildReadModel } from "../projections/read-model.js";

export function createAuditService({ store }) {
  /** 追溯单笔补贴分录。 */
  function traceEntry(entryId) {
    const model = buildReadModel(store);
    const entry = model.entries.get(entryId);
    if (!entry) throw new Error(`清算分录不存在：${entryId}`);

    const redemption = store.findEvent(entry.redemption_event_id);
    const rp = redemption?.payload ?? {};
    const account = model.accounts.get(entry.account_id);
    const ticket = model.tickets.get(account?.ticket_id);
    const match = model.matches.get(ticket?.match_session_id);
    const policy = model.policies.get(entry.policy_id);
    const device = model.devices.get(rp.device_id);
    const spot = model.spots.get(entry.spot_id);

    const pendingEvent = rp.pending_proof_id
      ? store.findEvent(rp.pending_proof_id) ??
        store.eventsByType("REDEMPTION_PENDING").find((e) => e.aggregate_id === rp.pending_proof_id)
      : null;

    // 该核销之后针对该账户的全部后续调整。
    const laterAdjustments = store
      .eventsByType("BENEFIT_ADJUSTED", "BENEFIT_REVOKED")
      .filter((e) => e.aggregate_id === entry.account_id)
      .map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        reason_code: e.payload?.reason_code,
        occurred_at: e.occurred_at,
      }));

    const appealEvents = store
      .eventsByType("APPEAL_FILED", "APPEAL_RESOLVED")
      .filter((e) => e.payload?.account_id === entry.account_id)
      .map((e) => ({
        event_id: e.event_id,
        event_type: e.event_type,
        decision: e.payload?.decision ?? null,
        subject_event_id: e.payload?.subject_event_id ?? null,
        occurred_at: e.occurred_at,
      }));

    const reversalEvent =
      entry.status === "REVERSED" ? store.findEvent(entry.reversal.reversed_event_id) : null;

    return {
      subsidy: {
        entry_id: entry.id,
        batch_id: entry.batch_id,
        amount_cents: entry.amount_cents,
        status: entry.status,
        priced_at: entry.priced_at,
        settlement_event_id: entry.settled_event_id,
      },
      redemption: {
        proof_id: redemption?.aggregate_id ?? null,
        event_id: entry.redemption_event_id,
        occurred_on_device_at: rp.occurred_on_device_at ?? null,
        channel: rp.channel ?? null,
        synced_at: rp.synced_at ?? null,
        policy_id: entry.policy_id,
        agreed_price_cents: rp.agreed_price_cents ?? null,
        ticket_status_at_capture: rp.ticket_status_at_capture ?? null,
      },
      offline_origin: rp.pending_proof_id
        ? {
            pending_proof_id: rp.pending_proof_id,
            device_seq: rp.device_seq ?? null,
            signature_verified: true,
            pending_event_id: pendingEvent?.event_id ?? null,
          }
        : null,
      device: device
        ? { device_id: device.device_id, bound_spot_id: device.spot_id, key_hint: device.public_key_hint }
        : null,
      spot: spot ? { spot_id: spot.id, name: spot.name } : null,
      policy: policy
        ? {
            policy_id: policy.id,
            policy_code: policy.policy_code,
            policy_version: policy.policy_version,
            redemption_scope: policy.redemption_scope,
            effective_from: policy.effective_from,
            effective_to: policy.effective_to,
            spot_term: policy.spot_terms.find((t) => t.spot_id === entry.spot_id) ?? null,
          }
        : null,
      ticket: ticket
        ? {
            ticket_id: ticket.id,
            match_session_id: ticket.match_session_id,
            serial: ticket.serial,
            media: ticket.media,
            current_status: ticket.status, // 补贴发放时回查的真实票务状态
            nominated: ticket.nominated,
            refunded_at: ticket.refunded_at ?? null,
          }
        : null,
      match: match
        ? { match_code: match.match_code, kicks_off_at: match.kicks_off_at, status: match.status }
        : null,
      reversal: entry.status === "REVERSED"
        ? {
            reason_code: entry.reversal.reason_code,
            amount_cents: entry.reversal.amount_cents,
            quota_restored: entry.reversal.quota_restored,
            event_id: entry.reversal.reversed_event_id,
            at: entry.reversal.at,
          }
        : null,
      later_adjustments: laterAdjustments,
      appeals: appealEvents,
    };
  }

  /** 批次内每笔补贴的追溯索引（财政对账）。 */
  function traceBatch(batchId) {
    const model = buildReadModel(store);
    const batch = model.batches.get(batchId);
    if (!batch) throw new Error(`批次不存在：${batchId}`);
    return batch.entry_ids.map((id) => traceEntry(id));
  }

  return { traceEntry, traceBatch };
}
