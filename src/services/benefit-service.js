/**
 * 权益服务：家庭代领/同行人关联、闭园补偿、申诉补权等对权益账户的调整。
 */
import { randomId, deriveToken } from "../kernel/ids.js";
import { iso } from "../kernel/clock.js";
import { buildReadModel, companionTerms } from "../projections/read-model.js";

export function createBenefitService({ store, tokenSecret, now = () => new Date() }) {
  const rm = () => buildReadModel(store);

  /** 关联家庭成员（可代领）或同行人；人数与关系受政策版本约束。 */
  function linkCompanion(accountId, { person_key, relationship }) {
    if (!["FAMILY", "GUEST"].includes(relationship)) {
      throw new Error("同伴关系必须是 FAMILY（家庭代领）或 GUEST（同行）");
    }
    const model = rm();
    const account = model.accounts.get(accountId);
    if (!account) throw new Error(`权益账户不存在：${accountId}`);
    if (account.revoked) throw new Error("账户剩余权利已冻结，不能关联同行人");
    const policy = model.policies.get(account.policy_id);
    if (!policy.companions_allowed) {
      throw new Error(`政策 ${policy.policy_code} v${policy.policy_version} 不允许家庭代领/同行`);
    }
    const personToken = deriveToken(tokenSecret, "holder", person_key);
    if (account.persons.has(personToken)) throw new Error("该成员已关联");
    const companionCount = [...account.persons.values()].filter(
      (p) => p.relationship === "FAMILY" || p.relationship === "GUEST",
    ).length;
    if (companionCount >= policy.max_companions) {
      throw new Error(`同行人数已达政策上限 ${policy.max_companions} 人`);
    }
    const eventId = randomId("evt");
    store.commit([
      {
        event_type: "BENEFIT_COMPANION_LINKED",
        aggregate_type: "benefit_account",
        aggregate_id: accountId,
        event_id: eventId,
        occurred_at: iso(now()),
        summary: `关联${relationship === "FAMILY" ? "家庭成员（代领）" : "同行人"}，按 ${policy.policy_code} v${policy.policy_version} 赋额`,
        payload: {
          person_token: personToken,
          relationship,
          terms: companionTerms(policy, personToken, eventId),
          linked_at: iso(now()),
        },
      },
    ]);
    return { person_token: personToken };
  }

  /**
   * 向账户补额度（闭园补偿/申诉支持/设备合并修正）。
   * spot_id 为 null 表示全局额度（GLOBAL 政策）。
   */
  function grantAdjustment(accountId, { reason_code, quota_grants, window, upstream_event_id = "" }) {
    const model = rm();
    if (!model.accounts.has(accountId)) throw new Error(`权益账户不存在：${accountId}`);
    const eventId = randomId("evt");
    store.commit([
      {
        event_type: "BENEFIT_ADJUSTED",
        aggregate_type: "benefit_account",
        aggregate_id: accountId,
        event_id: eventId,
        occurred_at: iso(now()),
        summary: `权益调整：${reason_code}`,
        payload: {
          reason_code,
          ...(window ? { window } : {}),
          quota_grants: quota_grants ?? [],
          upstream_event_id,
        },
      },
    ]);
    return eventId;
  }

  return { linkCompanion, grantAdjustment };
}
