/**
 * 离线核销终端（山水景区断网场景）。
 * - 扫描凭证：平台签名离线验证；用本景区密钥仅能解开本景区加密条目，读不到其他景区；
 * - 条目给出该景区专属假名、政策版本、剩余次数；本地按设备序号记账防同机重刷；
 * - 每笔签发设备签名的“待同步凭证”（只含景区假名），联网后由平台解析全局身份并按发生时间合并；
 * - 离线拒绝同样留痕，同步后成为可申诉记录。
 */
import { randomId, signPayload, canonicalPendingPayload } from "../kernel/ids.js";
import { openEntitlement, openSpotEntry } from "../kernel/entitlement.js";
import { isBetween } from "../kernel/clock.js";

export function createOfflineTerminal({ device, deviceSecret, platformSecret, spotMasterSecret, clock = () => new Date() }) {
  let seq = 0;
  const pending = [];
  const denials = [];
  const spentByTerm = new Map(); // term_id -> 本设备离线会话内已签发次数

  function scan(voucher, { at = clock() } = {}) {
    const atIso = at instanceof Date ? at.toISOString() : at;
    const claims = openEntitlement(platformSecret, voucher);
    const base = { device_id: device.device_id, spot_id: device.spot_id, at: atIso };
    if (!claims) {
      return deny(denials, base, "SIGNATURE_INVALID", null, "凭证验签失败：伪造、损坏或非本平台签发");
    }
    base.policy_id = claims.policy_id;

    if (claims.window && !isBetween(atIso, claims.window.from, claims.window.to)) {
      return deny(denials, base, "OUTSIDE_WINDOW", claims.policy_id, "不在权益窗口内（以凭证内窗口为准）");
    }

    const box = claims.spots?.[device.spot_id];
    const entry = box ? openSpotEntry(spotMasterSecret, device.spot_id, box) : null;
    if (!entry) {
      // 密钥不匹配通常意味着设备被挪到别的景区；无条目意味着该票根不覆盖本景区。
      return deny(denials, base, "SPOT_NOT_COVERED", claims.policy_id, "该票根权益不覆盖本景区（无本景区加密条目）");
    }
    base.account_ref = entry.account_ref;
    base.person_ref = entry.person_ref;

    if ((entry.remaining ?? 0) <= 0) {
      return deny(
        denials,
        base,
        "QUOTA_USED",
        claims.policy_id,
        entry.scope === "GLOBAL"
          ? `离线判定：全部景区合计额度已用完（凭证签发时剩余 0 次）`
          : `离线判定：本景区额度已用完（凭证签发时剩余 0 次）`,
      );
    }

    const usedHere = spentByTerm.get(entry.term_id) ?? 0;
    if (usedHere >= entry.remaining) {
      return deny(
        denials,
        base,
        "QUOTA_USED",
        claims.policy_id,
        entry.scope === "GLOBAL"
          ? `离线判定：合计额度 ${entry.remaining} 次已在本设备刷完（跨设备冲突联网合并时裁定）`
          : `离线判定：本景区额度 ${entry.remaining} 次已在本设备刷完`,
      );
    }
    if (pending.length >= (device.offline_quota ?? 0)) {
      return deny(
        denials,
        base,
        "OFFLINE_QUOTA_EXCEEDED",
        claims.policy_id,
        `设备离线签发额度 ${device.offline_quota} 已满，请恢复联网同步后再核销`,
      );
    }

    seq += 1;
    const proof_id = randomId("pend");
    const draft = {
      proof_id,
      device_id: device.device_id,
      spot_id: device.spot_id,
      account_ref: entry.account_ref,
      person_ref: entry.person_ref,
      relationship: entry.relationship,
      policy_id: claims.policy_id,
      benefit_term_id: entry.term_id,
      occurred_on_device_at: atIso,
      device_seq: seq,
    };
    const signature = signPayload(deviceSecret, canonicalPendingPayload(draft));
    const record = { ...draft, signature };
    pending.push(record);
    spentByTerm.set(entry.term_id, usedHere + 1);
    return { status: "PENDING", ...record };
  }

  function exportBundle() {
    return {
      device_id: device.device_id,
      pending: pending.map((x) => ({ ...x })),
      denials: denials.map((x) => ({ ...x })),
    };
  }

  function markSynced(proofIds, denialKeys) {
    for (let i = pending.length - 1; i >= 0; i--) {
      if (proofIds.includes(pending[i].proof_id)) pending.splice(i, 1);
    }
    for (let i = denials.length - 1; i >= 0; i--) {
      if (denialKeys.includes(denials[i].client_key)) denials.splice(i, 1);
    }
  }

  return { scan, exportBundle, markSynced, get pendingCount() { return pending.length; } };
}

function deny(denials, base, reason_code, policy_id, rule_detail) {
  const record = {
    client_key: randomId("deny"),
    device_id: base.device_id,
    spot_id: base.spot_id,
    occurred_on_device_at: base.at,
    policy_id: policy_id ?? null,
    reason_code,
    rule_detail,
    account_ref: base.account_ref ?? null,
    person_ref: base.person_ref ?? null,
  };
  denials.push(record);
  return { status: "REJECTED_OFFLINE", ...record };
}
