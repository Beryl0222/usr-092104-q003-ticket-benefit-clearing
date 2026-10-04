/**
 * 离线同步合并。
 * 恢复联网后，终端上传待同步凭证与离线拒绝留痕（只含景区假名）：
 * 1. 设备身份 + 凭证签名校验，伪造件直接作废；
 * 2. 平台用主密钥把景区假名解析为全局权益账户/人；
 * 3. 全部待同步凭证按业务发生时间、设备身份、设备序号排序，在时点读模型上逐条重放
 *    （发生在退款/闭园之前的核销仍然有效）；
 * 4. 跨设备同一权利项竞争：时间线先发生者 CAPTURED，后到者 VOIDED(DOUBLE_SPEND/QUOTA_CONFLICT)，可申诉；
 *    离线拒绝留痕转成可申诉的 REDEMPTION_REJECTED；
 * 5. proof_id / client_key 幂等，重复同步不重复入账。
 */
import { iso } from "../kernel/clock.js";
import { verifySignature, canonicalPendingPayload } from "../kernel/ids.js";
import { buildReadModelAt } from "../projections/read-model.js";
import { buildResolver } from "../kernel/pseudonyms.js";
import { evaluateEligibility } from "./redemption-service.js";

export function createSyncService({ store, deviceRegistry, tokenSecret, now = () => new Date() }) {
  function syncBundle(bundle) {
    const syncedAt = iso(now());
    const current = buildReadModelAt(store, syncedAt);
    const device = current.devices.get(bundle.device_id);
    if (!device) throw new Error(`同步被拒：设备 ${bundle.device_id} 未登记`);
    const secret = deviceRegistry.getSecret(device.device_id);
    if (!secret) throw new Error(`设备 ${device.device_id} 缺少验签密钥（未在本节点登记）`);
    const resolver = buildResolver(current, tokenSecret);

    const result = { captured: [], voided: [], rejected: [], denials: [] };
    const correlationId = `sync_${device.device_id}_${Date.parse(syncedAt)}`;

    const pendings = [...bundle.pending].sort((a, b) => {
      return (
        new Date(a.occurred_on_device_at) - new Date(b.occurred_on_device_at) ||
        a.device_id.localeCompare(b.device_id) ||
        (a.device_seq ?? 0) - (b.device_seq ?? 0) ||
        a.proof_id.localeCompare(b.proof_id)
      );
    });

    for (const p of pendings) {
      const already = store
        .eventsByType("REDEMPTION_CAPTURED", "REDEMPTION_VOIDED")
        .find((e) => e.payload?.pending_proof_id === p.proof_id);
      if (already) {
        result[already.event_type === "REDEMPTION_CAPTURED" ? "captured" : "voided"].push({
          proof_id: p.proof_id,
          event_id: already.event_id,
          idempotent_replay: true,
        });
        continue;
      }

      const signatureOk =
        p.device_id === device.device_id &&
        p.spot_id === device.spot_id &&
        verifySignature(secret, canonicalPendingPayload(p), p.signature);

      if (!signatureOk) {
        commitVoid(store, p, "SIGNATURE_INVALID", "同步验签失败：凭证载荷与设备签名不符（伪造或损坏）", syncedAt);
        result.voided.push({ proof_id: p.proof_id, reason_code: "SIGNATURE_INVALID" });
        continue;
      }

      // 景区假名 -> 全局账户。解析必须在“发生时点”的模型上做（转赠后旧令牌仍应在历史时点可解）。
      const modelAt = buildReadModelAt(store, p.occurred_on_device_at);
      const resolverAt = buildResolver(modelAt, tokenSecret);
      const accountIdFromRef = resolverAt.resolveAccount(p.spot_id, p.account_ref);
      const resolved = accountIdFromRef
        ? resolverAt.resolvePerson(p.spot_id, p.person_ref)
        : null;
      if (!resolved || resolved.accountId !== accountIdFromRef) {
        commitRejection(
          store,
          p,
          {
            ok: false,
            reason_code: "RELATIONSHIP_DENIED",
            policy_id: p.policy_id ?? null,
            rule_detail: "景区假名无法解析到与凭证一致的有效权益账户（凭证已失效或关系不存在）",
          },
          syncedAt,
          correlationId,
          null,
        );
        result.rejected.push({ proof_id: p.proof_id, reason_code: "RELATIONSHIP_DENIED" });
        continue;
      }
      const { accountId, personToken } = resolved;

      const verdict = evaluateEligibility(modelAt, {
        device_id: p.device_id,
        spot_id: p.spot_id,
        person_token: personToken,
        account_id: accountId,
        at: p.occurred_on_device_at,
      });

      if (!verdict.ok) {
        if (verdict.reason_code === "QUOTA_USED") {
          const sameInstant = isTieConflict(store, p, accountId);
          const code = sameInstant ? "QUOTA_CONFLICT" : "DOUBLE_SPEND";
          commitVoid(
            store,
            p,
            code,
            sameInstant
              ? "多台设备在同一时刻消费同一权利项，按设备身份裁定本笔落选，可申诉补权"
              : `同一权利项在更早时间已被消费（按发生时间合并）：${verdict.rule_detail}`,
            syncedAt,
            accountId,
            personToken,
          );
          result.voided.push({ proof_id: p.proof_id, reason_code: code });
        } else {
          const eventId = commitRejection(store, p, verdict, syncedAt, correlationId, { accountId, personToken });
          result.rejected.push({ proof_id: p.proof_id, reason_code: verdict.reason_code, event_id: eventId });
        }
        continue;
      }

      const [, captured] = store.commit(
        [
          {
            event_type: "REDEMPTION_PENDING",
            aggregate_type: "redemption_proof",
            aggregate_id: p.proof_id,
            occurred_at: p.occurred_on_device_at,
            summary: `离线待同步凭证（设备 ${p.device_id} #${p.device_seq}）`,
            payload: {
              device_id: p.device_id,
              spot_id: p.spot_id,
              account_id: accountId,
              person_token: personToken,
              account_ref: p.account_ref,
              person_ref: p.person_ref,
              relationship: verdict.relationship,
              policy_id: p.policy_id,
              benefit_term_id: p.benefit_term_id,
              occurred_on_device_at: p.occurred_on_device_at,
              device_seq: p.device_seq,
              signature: p.signature,
              sync_state: "PENDING",
            },
          },
          {
            event_type: "REDEMPTION_CAPTURED",
            aggregate_type: "redemption_proof",
            aggregate_id: p.proof_id,
            occurred_at: p.occurred_on_device_at,
            summary: `离线核销合并成功：${p.spot_id}（发生于 ${p.occurred_on_device_at}，计价 ${verdict.price_cents} 分）`,
            payload: {
              device_id: p.device_id,
              spot_id: p.spot_id,
              account_id: verdict.account.id,
              person_token: personToken,
              account_ref: p.account_ref,
              person_ref: p.person_ref,
              relationship: verdict.relationship,
              policy_id: verdict.policy.id,
              benefit_term_id: p.benefit_term_id,
              channel: "OFFLINE_SYNC",
              occurred_on_device_at: p.occurred_on_device_at,
              device_seq: p.device_seq,
              agreed_price_cents: verdict.price_cents,
              pending_proof_id: p.proof_id,
              synced_at: syncedAt,
              ticket_status_at_capture: verdict.ticket?.status ?? null,
            },
          },
        ],
        { correlationId },
      );
      result.captured.push({
        proof_id: p.proof_id,
        event_id: captured.event_id,
        account_id: verdict.account.id,
        price_cents: verdict.price_cents,
      });
    }

    for (const d of bundle.denials ?? []) {
      const existed = store
        .eventsByType("REDEMPTION_REJECTED")
        .find((e) => e.payload?.client_key === d.client_key);
      if (existed) {
        result.denials.push({ client_key: d.client_key, idempotent_replay: true });
        continue;
      }
      const proofId = `prf_deny_${d.client_key}`;
      const resolved =
        d.person_ref && d.spot_id ? resolver.resolvePerson(d.spot_id, d.person_ref) : null;
      const [event] = store.commit(
        [
          {
            event_type: "REDEMPTION_REJECTED",
            aggregate_type: "redemption_proof",
            aggregate_id: proofId,
            occurred_at: d.occurred_on_device_at,
            summary: `离线拒绝留痕合并：${d.reason_code}`,
            payload: {
              device_id: d.device_id,
              spot_id: d.spot_id,
              account_id: resolved?.accountId ?? null,
              person_token: resolved?.personToken ?? null,
              account_ref: d.account_ref ?? null,
              person_ref: d.person_ref ?? null,
              policy_id: d.policy_id ?? null,
              reason_code: d.reason_code,
              rule_detail: d.rule_detail,
              occurred_on_device_at: d.occurred_on_device_at,
              channel: "OFFLINE_SYNC",
              client_key: d.client_key,
            },
          },
        ],
        { correlationId },
      );
      result.denials.push({ client_key: d.client_key, event_id: event.event_id });
    }

    return result;
  }

  return { syncBundle };
}

function commitVoid(store, p, reasonCode, note, syncedAt, accountId = null, personToken = null) {
  store.commit(
    [
      {
        event_type: "REDEMPTION_PENDING",
        aggregate_type: "redemption_proof",
        aggregate_id: p.proof_id,
        occurred_at: p.occurred_on_device_at ?? syncedAt,
        summary: `离线待同步凭证（设备 ${p.device_id}）`,
        payload: {
          device_id: p.device_id,
          spot_id: p.spot_id,
          account_id: accountId,
          person_token: personToken,
          account_ref: p.account_ref ?? null,
          person_ref: p.person_ref ?? null,
          relationship: p.relationship ?? null,
          policy_id: p.policy_id ?? null,
          benefit_term_id: p.benefit_term_id ?? null,
          occurred_on_device_at: p.occurred_on_device_at ?? syncedAt,
          device_seq: p.device_seq ?? null,
          signature: p.signature ?? null,
          sync_state: "PENDING",
        },
      },
      {
        event_type: "REDEMPTION_VOIDED",
        aggregate_type: "redemption_proof",
        aggregate_id: p.proof_id,
        occurred_at: syncedAt,
        summary: `离线凭证作废：${reasonCode}`,
        payload: { pending_proof_id: p.proof_id, reason_code: reasonCode, note },
      },
    ],
    { correlationId: `void_${p.proof_id}` },
  );
}

function commitRejection(store, p, verdict, syncedAt, correlationId, resolved) {
  const [event] = store.commit(
    [
      {
        event_type: "REDEMPTION_REJECTED",
        aggregate_type: "redemption_proof",
        aggregate_id: p.proof_id,
        occurred_at: p.occurred_on_device_at ?? syncedAt,
        summary: `离线核销合并后拒绝：${verdict.reason_code}`,
        payload: {
          device_id: p.device_id,
          spot_id: p.spot_id,
          account_id: resolved?.accountId ?? verdict.account?.id ?? null,
          person_token: resolved?.personToken ?? null,
          account_ref: p.account_ref ?? null,
          person_ref: p.person_ref ?? null,
          policy_id: verdict.policy_id,
          reason_code: verdict.reason_code,
          rule_detail: verdict.rule_detail,
          occurred_on_device_at: p.occurred_on_device_at ?? syncedAt,
          channel: "OFFLINE_SYNC",
        },
      },
    ],
    { correlationId },
  );
  return event.event_id;
}

function isTieConflict(store, p, accountId) {
  return store.eventsByType("REDEMPTION_CAPTURED").some(
    (e) =>
      e.payload?.benefit_term_id === p.benefit_term_id &&
      e.payload?.account_id === accountId &&
      e.payload?.occurred_on_device_at === p.occurred_on_device_at,
  );
}
