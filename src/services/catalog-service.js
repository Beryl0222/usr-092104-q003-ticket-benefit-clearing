/**
 * 目录服务：比赛场次、权益政策版本、景区营业窗口、核销设备登记。
 * 政策版本一经发布不可变；新版本另发 POLICY_PUBLISHED，核销与拒绝始终记录所依据的版本。
 */
import { randomId } from "../kernel/ids.js";
import { iso } from "../kernel/clock.js";
import { buildReadModel } from "../projections/read-model.js";

export function createCatalogService({ store, now = () => new Date() }) {
  const rm = () => buildReadModel(store);

  function scheduleMatch({ match_code, home_team, away_team, kicks_off_at, venue }) {
    const matchId = randomId("match");
    store.commit([
      {
        event_type: "MATCH_SCHEDULED",
        aggregate_type: "match_session",
        aggregate_id: matchId,
        occurred_at: iso(now()),
        summary: `场次 ${match_code}：${home_team} vs ${away_team}`,
        payload: { match_code, home_team, away_team, kicks_off_at, venue },
      },
    ]);
    return matchId;
  }

  /**
   * 发布政策版本。同一 policy_code 的生效区间不得重叠，保证任一时刻只有一版生效，
   * “一次拒绝依据哪版规则”可被唯一回答。
   */
  function publishPolicy(rules) {
    const model = rm();
    const versions = model.policyVersions.get(rules.policy_code) ?? [];
    for (const id of versions) {
      const old = model.policies.get(id);
      if (overlaps(rules.effective_from, rules.effective_to, old.effective_from, old.effective_to)) {
        throw new Error(
          `政策 ${rules.policy_code} v${rules.policy_version} 与 v${old.policy_version} 生效区间重叠`,
        );
      }
    }
    const policyId = `pol_${rules.policy_code}_v${rules.policy_version}`;
    store.commit([
      {
        event_type: "POLICY_PUBLISHED",
        aggregate_type: "benefit_policy",
        aggregate_id: policyId,
        occurred_at: iso(now()),
        summary: `发布权益政策 ${rules.policy_code} v${rules.policy_version}（${rules.redemption_scope}）`,
        payload: { ...rules },
      },
    ]);
    return policyId;
  }

  function registerSpot({ spot_id, name, windows, remote_offline_allowed = false }) {
    store.commit([
      {
        event_type: "SPOT_REGISTERED",
        aggregate_type: "scenic_spot",
        aggregate_id: spot_id,
        occurred_at: iso(now()),
        summary: `景区登记：${name}`,
        payload: { name, windows, remote_offline_allowed },
      },
    ]);
    return spot_id;
  }

  function updateWindows(spotId, windows) {
    const model = rm();
    if (!model.spots.has(spotId)) throw new Error(`景区不存在：${spotId}`);
    // 营业窗口调整只影响未发生的核销：窗口整体替换，历史凭证仍引用其发生时的判定。
    store.commit([
      {
        event_type: "SPOT_WINDOWS_UPDATED",
        aggregate_type: "scenic_spot",
        aggregate_id: spotId,
        occurred_at: iso(now()),
        summary: `景区 ${spotId} 更新营业窗口`,
        payload: { windows },
      },
    ]);
  }

  function closeSpot(spotId, { from, to, reason }) {
    store.commit([
      {
        event_type: "SPOT_CLOSED",
        aggregate_type: "scenic_spot",
        aggregate_id: spotId,
        occurred_at: iso(now()),
        summary: `景区 ${spotId} 临时闭园：${reason}`,
        payload: { from, to, reason },
      },
    ]);
  }

  return { scheduleMatch, publishPolicy, registerSpot, updateWindows, closeSpot };
}

function overlaps(fromA, toA, fromB, toB) {
  const a0 = Date.parse(fromA);
  const a1 = toA ? Date.parse(toA) : Infinity;
  const b0 = Date.parse(fromB);
  const b1 = toB ? Date.parse(toB) : Infinity;
  return a0 < b1 && b0 < a1;
}
