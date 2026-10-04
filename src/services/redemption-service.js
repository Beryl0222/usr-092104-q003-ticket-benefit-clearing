/**
 * 权益资格判定（纯函数）与在线核销。
 * 是否允许跨景区重复使用由所适用政策版本的 redemption_scope 决定，核销端不做一刀切去重；
 * 每次拒绝都产出 REDEMPTION_REJECTED，写明 policy_id（哪版规则）与逐条依据，可直接展示给游客并用于申诉。
 */
import { randomId } from "../kernel/ids.js";
import { iso, isBetween, spotOpenAt, policyEffectiveAt } from "../kernel/clock.js";
import { buildReadModel, buildReadModelAt, remainingFor } from "../projections/read-model.js";
import { buildResolver } from "../kernel/pseudonyms.js";
import { spotAccountPseudonym, spotPersonPseudonym } from "../kernel/pseudonyms.js";
import { openEntitlement, openSpotEntry } from "../kernel/entitlement.js";

/**
 * 判定一笔核销请求。model 可为时点模型（离线按发生时间重放）。
 * @param account_id 可选：凭证景区假名指向的具体权益账户，用于同一自然人名下多张票时消歧。
 * @returns {{ok:true, account:object, relationship:string, policy:object, term:object, price_cents:number, ticket:object} |
 *           {ok:false, reason_code:string, policy_id:string|null, rule_detail:string, account?:object}}
 */
export function evaluateEligibility(model, { device_id, spot_id, person_token, at, account_id }) {
  const device = model.devices.get(device_id);
  if (!device) {
    return reject("DEVICE_UNKNOWN", null, `设备 ${device_id} 未登记，不能签发任何核销凭证`);
  }
  if (device.spot_id !== spot_id) {
    return reject(
      "DEVICE_SPOT_MISMATCH",
      null,
      `设备 ${device_id} 绑定景区 ${device.spot_id}，不得在 ${spot_id} 核销（防跨景区冒刷）`,
    );
  }

  const spot = model.spots.get(spot_id);
  if (!spot) return reject("SPOT_NOT_COVERED", null, `景区 ${spot_id} 未登记`);

  const found = findPersonAccount(model, person_token, account_id);
  if (!found) {
    return reject("RELATIONSHIP_DENIED", null, "查不到与该持票令牌关联的权益账户（未记名或非家庭成员/同行人）");
  }
  const { account, relationship } = found;
  const ticket = model.tickets.get(account.ticket_id);

  if (account.revoked) {
    if (account.revoked.reason_code === "TICKET_REFUNDED") {
      return reject(
        "TICKET_REFUNDED",
        account.policy_id,
        `票根已于 ${account.revoked.at} 退票，仅尚未消费的权利失效；该笔请求时间晚于退票时间`,
        account,
      );
    }
    if (account.revoked.reason_code === "TICKET_INVALIDATED") {
      return reject("TICKET_INVALIDATED", account.policy_id, `票根已作废：${account.revoked.note ?? ""}`, account);
    }
  }

  const policy = model.policies.get(account.policy_id);
  if (!policy) return reject("EXPIRED_POLICY", null, "授予权益的政策版本缺失", account);
  const versionRef = `${policy.policy_code} v${policy.policy_version}`;

  if (!policyEffectiveAt(policy, at)) {
    return reject(
      "EXPIRED_POLICY",
      policy.id,
      `依据 ${versionRef}，其生效区间为 ${policy.effective_from} 至 ${policy.effective_to ?? "长期"}，请求时间 ${at} 不在区间内`,
      account,
    );
  }
  const term = policy.spot_terms.find((t) => t.spot_id === spot_id);
  if (!term) {
    return reject(
      "SPOT_NOT_COVERED",
      policy.id,
      `依据 ${versionRef}，景区 ${spot.name}（${spot_id}）不在该票根权益覆盖的 ${policy.spot_terms.length} 家景区名单内`,
      account,
    );
  }
  if (term.requires_nomination && ticket && !ticket.nominated) {
    return reject(
      "NOT_NOMINATED",
      policy.id,
      `依据 ${versionRef}，${spot.name} 要求票根记名后方可使用，当前纸票/赠票尚未记名`,
      account,
    );
  }
  if (!isBetween(at, account.window.from, account.window.to)) {
    return reject(
      "OUTSIDE_WINDOW",
      policy.id,
      `依据 ${versionRef}，权益窗口为 ${account.window.from} 至 ${account.window.to}（相对开赛 ${policy.match_window.start_offset_hours}h/${policy.match_window.end_offset_hours}h），请求时间 ${at} 超出窗口`,
      account,
    );
  }
  if (!spotOpenAt(spot, at)) {
    const closure = (spot.closures ?? []).find((c) => isBetween(at, c.from, c.to));
    return reject(
      "SPOT_CLOSED",
      policy.id,
      closure
        ? `景区临时闭园（${closure.from} 至 ${closure.to}：${closure.reason}），闭园期间不可核销，可就损失提出申诉`
        : `不在景区公布的营业时段内（请求时间 ${at}）`,
      account,
    );
  }
  const left = remainingFor(model, account, person_token, spot_id);
  if (left.remaining <= 0) {
    const scopeText =
      policy.redemption_scope === "PER_SPOT"
        ? `该景区额度 ${left.total} 次已用完（跨景区可分别使用，不影响其他景区）`
        : `全部景区合计额度 ${left.total} 次已用完（本版政策要求跨景区去重）`;
    return reject("QUOTA_USED", policy.id, `依据 ${versionRef}，${scopeText}`, account);
  }

  return {
    ok: true,
    account,
    relationship,
    policy,
    term,
    price_cents: term.agreed_price_cents,
    ticket,
  };
}

function reject(reason_code, policy_id, rule_detail, account = undefined) {
  return { ok: false, reason_code, policy_id, rule_detail, ...(account ? { account } : {}) };
}

function findPersonAccount(model, personToken, accountId) {
  if (accountId) {
    const account = model.accounts.get(accountId);
    const person = account?.persons.get(personToken);
    return person ? { account, relationship: person.relationship } : null;
  }
  for (const account of model.accounts.values()) {
    const person = account.persons.get(personToken);
    if (person) return { account, relationship: person.relationship };
  }
  return null;
}

export function createRedemptionService({
  store,
  deviceRegistry,
  tokenSecret,
  platformSecret,
  spotMasterSecret,
  now = () => new Date(),
}) {
  /**
   * 景区扫码在线核销：解开凭证的本景区加密条目，解析景区假名为全局账户后判定。
   * 终端侧只持有 voucher 与本景区密钥，不接触全局身份。
   */
  function redeemVoucher({ device_id, spot_id, voucher, idempotency_key }) {
    const model = buildReadModel(store);
    const claims = openEntitlement(platformSecret, voucher);
    if (!claims) {
      return commitRejectionOnly(store, iso(now()), {
        device_id,
        spot_id,
        person_token: null,
        policy_id: null,
        reason_code: "SIGNATURE_INVALID",
        rule_detail: "凭证验签失败：伪造、损坏或非本平台签发",
        channel: "ONLINE",
        idempotency_key,
      });
    }
    const box = claims.spots?.[spot_id];
    const entry = box ? openSpotEntry(spotMasterSecret, spot_id, box) : null;
    if (!entry) {
      return commitRejectionOnly(store, iso(now()), {
        device_id,
        spot_id,
        person_token: null,
        policy_id: claims.policy_id,
        reason_code: "SPOT_NOT_COVERED",
        rule_detail: "该票根权益不覆盖本景区（无本景区加密条目）",
        channel: "ONLINE",
        idempotency_key,
      });
    }
    const resolver = buildResolver(model, tokenSecret);
    const accountId = resolver.resolveAccount(spot_id, entry.account_ref);
    const resolved = accountId ? resolver.resolvePerson(spot_id, entry.person_ref) : null;
    if (!resolved || (accountId && resolved.accountId !== accountId)) {
      return commitRejectionOnly(store, iso(now()), {
        device_id,
        spot_id,
        person_token: null,
        policy_id: claims.policy_id,
        reason_code: "RELATIONSHIP_DENIED",
        rule_detail: "景区假名无法解析到有效权益账户",
        channel: "ONLINE",
        idempotency_key,
      });
    }
    return redeem({
      device_id,
      spot_id,
      person_token: resolved.personToken,
      account_id: resolved.accountId,
      idempotency_key,
    });
  }

  /** 在线核销（内部入口：直接给全局持票令牌）。 */
  function redeem({ device_id, spot_id, person_token, account_id, idempotency_key }) {
    const at = iso(now());
    const model = buildReadModel(store);

    if (idempotency_key) {
      const existing = store
        .eventsByType("REDEMPTION_CAPTURED", "REDEMPTION_REJECTED")
        .find((e) => e.payload?.client_key === idempotency_key);
      if (existing) return resultFromEvent(existing);
    }

    const verdict = evaluateEligibility(model, { device_id, spot_id, person_token, at, account_id });
    const proofId = randomId("prf");
    const refs = (accountId) => ({
      account_ref: spotAccountPseudonym(tokenSecret, spot_id, accountId),
      person_ref: spotPersonPseudonym(tokenSecret, spot_id, person_token),
    });
    if (!verdict.ok) {
      const [event] = store.commit([
        {
          event_type: "REDEMPTION_REJECTED",
          aggregate_type: "redemption_proof",
          aggregate_id: proofId,
          occurred_at: at,
          summary: `核销拒绝：${verdict.reason_code}`,
          payload: {
            device_id,
            spot_id,
            account_id: verdict.account?.id ?? null,
            person_token,
            ...(verdict.account ? refs(verdict.account.id) : { account_ref: null, person_ref: null }),
            policy_id: verdict.policy_id,
            reason_code: verdict.reason_code,
            rule_detail: verdict.rule_detail,
            occurred_on_device_at: at,
            channel: "ONLINE",
            ...(idempotency_key ? { client_key: idempotency_key } : {}),
          },
        },
      ]);
      return { status: "REJECTED", proof_id: proofId, event_id: event.event_id, ...verdict };
    }

    const [event] = store.commit([
      {
        event_type: "REDEMPTION_CAPTURED",
        aggregate_type: "redemption_proof",
        aggregate_id: proofId,
        occurred_at: at,
        summary: `${spot_id} 核销成功（持票关系 ${verdict.relationship}，计价 ${verdict.price_cents} 分）`,
        payload: {
          device_id,
          spot_id,
          account_id: verdict.account.id,
          person_token,
          ...refs(verdict.account.id),
          relationship: verdict.relationship,
          policy_id: verdict.policy.id,
          benefit_term_id: pickTermId(model, verdict, person_token),
          channel: "ONLINE",
          occurred_on_device_at: at,
          device_seq: null,
          agreed_price_cents: verdict.price_cents,
          pending_proof_id: null,
          synced_at: null,
          ticket_status_at_capture: verdict.ticket?.status ?? null,
          ...(idempotency_key ? { client_key: idempotency_key } : {}),
        },
      },
    ]);
    return {
      status: "CAPTURED",
      proof_id: proofId,
      event_id: event.event_id,
      account_id: verdict.account.id,
      relationship: verdict.relationship,
      policy_id: verdict.policy.id,
      price_cents: verdict.price_cents,
    };
  }

  return { redeem, redeemVoucher };
}

/** 无法解析凭证/条目时的在线拒绝（没有账户上下文，也要留痕并给出依据版本）。 */
function commitRejectionOnly(store, at, r) {
  const proofId = randomId("prf");
  const [event] = store.commit([
    {
      event_type: "REDEMPTION_REJECTED",
      aggregate_type: "redemption_proof",
      aggregate_id: proofId,
      occurred_at: at,
      summary: `核销拒绝：${r.reason_code}`,
      payload: {
        device_id: r.device_id,
        spot_id: r.spot_id,
        account_id: null,
        person_token: r.person_token,
        account_ref: null,
        person_ref: null,
        policy_id: r.policy_id,
        reason_code: r.reason_code,
        rule_detail: r.rule_detail,
        occurred_on_device_at: at,
        channel: r.channel,
        ...(r.idempotency_key ? { client_key: r.idempotency_key } : {}),
      },
    },
  ]);
  return {
    status: "REJECTED",
    proof_id: proofId,
    event_id: event.event_id,
    ok: false,
    reason_code: r.reason_code,
    rule_detail: r.rule_detail,
    policy_id: r.policy_id,
  };
}

function pickTermId(model, verdict, personToken) {
  const left = remainingFor(model, verdict.account, personToken, verdict.term.spot_id);
  return left.terms[0]?.term_id ?? null;
}

function resultFromEvent(event) {
  if (event.event_type === "REDEMPTION_CAPTURED") {
    return {
      status: "CAPTURED",
      proof_id: event.aggregate_id,
      event_id: event.event_id,
      account_id: event.payload.account_id,
      relationship: event.payload.relationship,
      policy_id: event.payload.policy_id,
      price_cents: event.payload.agreed_price_cents,
      idempotent_replay: true,
    };
  }
  return {
    status: "REJECTED",
    proof_id: event.aggregate_id,
    event_id: event.event_id,
    reason_code: event.payload.reason_code,
    rule_detail: event.payload.rule_detail,
    policy_id: event.payload.policy_id,
    idempotent_replay: true,
  };
}
