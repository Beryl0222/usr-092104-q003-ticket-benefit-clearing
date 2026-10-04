/**
 * 异常申诉服务。
 * 游客可就每一次拒绝/离线作废/闭园损失提交证据；支持（UPHELD）时以 BENEFIT_ADJUSTED 补权，
 * 申诉事件与补权事件以 causation 关联，主管部门可双向回查。
 */
import { randomId, sha256 } from "../kernel/ids.js";
import { iso } from "../kernel/clock.js";
import { buildReadModel } from "../projections/read-model.js";

export function createAppealService({ store, benefitService, now = () => new Date() }) {
  const rm = () => buildReadModel(store);

  /**
   * @param evidence [{kind:'PHOTO'|'RECEIPT'|'SCREENSHOT'|'STATEMENT', content:string}]
   * 证据正文不进事件流，仅留存内容指纹与类型，避免敏感材料随事件外发。
   */
  function fileAppeal({ account_id, person_token, subject_type, subject_event_id, statement, evidence = [] }) {
    const model = rm();
    if (account_id && !model.accounts.has(account_id)) throw new Error(`权益账户不存在：${account_id}`);
    if (!["REJECTION", "VOIDED_PENDING", "CLOSURE_LOSS", "OTHER"].includes(subject_type)) {
      throw new Error(`未知申诉类型：${subject_type}`);
    }
    const appealId = randomId("apl");
    const at = iso(now());
    const evidenceRefs = evidence.map((ev) => ({
      evidence_id: randomId("evd"),
      kind: ev.kind,
      sha256: sha256(ev.content),
      submitted_at: at,
    }));
    store.commit([
      {
        event_type: "APPEAL_FILED",
        aggregate_type: "benefit_appeal",
        aggregate_id: appealId,
        occurred_at: at,
        summary: `申诉提交：${subject_type}（${evidenceRefs.length} 份证据）`,
        payload: {
          account_id,
          person_token,
          subject_type,
          subject_event_id,
          evidence: evidenceRefs,
          statement,
        },
      },
    ]);
    return { appeal_id: appealId };
  }

  /**
   * 处理申诉。
   * @param decision 'UPHELD'|'REJECTED'
   * @param grant 支持时的补权动作 {quota_grants:[{person_token,spot_id,amount}], window?}
   */
  function resolveAppeal(appealId, { decision, resolved_by, resolution, grant = null }) {
    const model = rm();
    const appeal = model.appeals.get(appealId);
    if (!appeal) throw new Error(`申诉不存在：${appealId}`);
    if (appeal.status !== "OPEN") throw new Error(`申诉已处理：${appeal.status}`);

    let adjustmentEventId = null;
    if (decision === "UPHELD" && grant && appeal.account_id) {
      adjustmentEventId = benefitService.grantAdjustment(appeal.account_id, {
        reason_code: "APPEAL_GRANTED",
        quota_grants: grant.quota_grants ?? [],
        window: grant.window,
        upstream_event_id: appeal.filed_event_id,
      });
    }

    store.commit([
      {
        event_type: "APPEAL_RESOLVED",
        aggregate_type: "benefit_appeal",
        aggregate_id: appealId,
        occurred_at: iso(now()),
        summary: `申诉${decision === "UPHELD" ? "支持" : "驳回"}：${resolution}`,
        payload: {
          decision,
          resolved_by,
          resolution,
          adjustment_event_id: adjustmentEventId,
        },
      },
    ]);
    return { appeal_id: appealId, decision, adjustment_event_id: adjustmentEventId };
  }

  return { fileAppeal, resolveAppeal };
}
