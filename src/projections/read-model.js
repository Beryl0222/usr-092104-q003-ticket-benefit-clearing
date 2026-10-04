/**
 * 全局读模型：把事件存储折叠成各服务/视图需要的索引。
 * 纯函数，便于在任何命令前重建；线上版本可改为订阅增量投影。
 */

export function buildReadModel(store) {
  return fold(store.allByCommit(), null);
}

/**
 * 时点读模型：只折叠 occurred_at <= asOf 的事件。
 * 离线合并必须按“业务发生时间”重放——例如发生在退款之前的离线核销依然有效。
 */
export function buildReadModelAt(store, asOf) {
  const cutoff = new Date(asOf).getTime();
  return fold(
    store.allByCommit().filter((e) => new Date(e.occurred_at).getTime() <= cutoff),
    null,
  );
}

function fold(events, _unused) {
  const rm = {
    matches: new Map(),
    tickets: new Map(),
    ticketsBySerial: new Map(),
    policies: new Map(), // policy_id（某代码的某一版本，不可变）
    policyVersions: new Map(), // policy_code -> [policy_id...] 按版本号
    accounts: new Map(),
    accountsByTicket: new Map(),
    spots: new Map(),
    devices: new Map(),
    proofs: new Map(), // redemption_proof 聚合：PENDING -> CAPTURED/VOIDED，或 REJECTED
    rejections: [],
    appeals: new Map(),
    batches: new Map(),
    entries: new Map(),
    entryByRedemption: new Map(), // redemption_event_id -> 在册（未冲正）分录
  };

  const upsert = (map, id, init) => {
    if (!map.has(id)) map.set(id, init());
    return map.get(id);
  };

  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.event_type) {
      case "MATCH_SCHEDULED": {
        rm.matches.set(e.aggregate_id, {
          id: e.aggregate_id,
          match_code: p.match_code,
          home_team: p.home_team,
          away_team: p.away_team,
          venue: p.venue,
          kicks_off_at: p.kicks_off_at,
          original_kicks_off_at: p.kicks_off_at,
          status: "SCHEDULED",
        });
        break;
      }
      case "MATCH_POSTPONED": {
        const m = rm.matches.get(e.aggregate_id);
        if (m) {
          m.kicks_off_at = p.new_kicks_off_at;
          m.status = "POSTPONED";
          m.postponed_at = e.occurred_at;
        }
        break;
      }
      case "TICKET_CONFIRMED": {
        rm.tickets.set(e.aggregate_id, {
          id: e.aggregate_id,
          match_session_id: p.match_session_id,
          serial: p.serial,
          media: p.media,
          holder_token: p.holder_token,
          status: "CONFIRMED",
          issued_at: p.issued_at,
          // 电子票购票即记名（nominated=true 由票务服务在事件中给出）；纸票/赠票需现场记名。
          nominated: p.nominated ?? false,
          transfers: [],
        });
        rm.ticketsBySerial.set(p.serial, e.aggregate_id);
        break;
      }
      case "TICKET_NOMINATED": {
        const t = rm.tickets.get(e.aggregate_id);
        if (t) {
          t.holder_token = p.holder_token;
          t.nominated = true;
          t.nomination_channel = p.channel;
          if (t.status === "CONFIRMED") t.status = "NOMINATED";
        }
        break;
      }
      case "TICKET_TRANSFERRED": {
        const t = rm.tickets.get(e.aggregate_id);
        if (t) {
          t.transfers.push({ from: p.from_holder_token, to: p.to_holder_token, at: e.occurred_at });
          t.holder_token = p.to_holder_token;
          t.status = "TRANSFERRED";
        }
        break;
      }
      case "TICKET_REFUNDED": {
        const t = rm.tickets.get(e.aggregate_id);
        if (t) {
          t.status = "REFUNDED";
          t.refunded_at = p.refunded_at;
          t.refund_reason = p.reason;
        }
        break;
      }
      case "TICKET_INVALIDATED": {
        const t = rm.tickets.get(e.aggregate_id);
        if (t) {
          t.status = "INVALIDATED";
          t.invalid_reason = p.reason;
        }
        break;
      }
      case "POLICY_PUBLISHED": {
        const rules = { ...p, id: e.aggregate_id };
        rm.policies.set(e.aggregate_id, rules);
        const list = rm.policyVersions.get(p.policy_code) ?? [];
        list.push(e.aggregate_id);
        list.sort((a, b) => rm.policies.get(a).policy_version - rm.policies.get(b).policy_version);
        rm.policyVersions.set(p.policy_code, list);
        break;
      }
      case "BENEFIT_GRANTED": {
        const acc = upsert(
          rm.accounts,
          e.aggregate_id,
          () => ({
            id: e.aggregate_id,
            ticket_id: p.ticket_id,
            match_session_id: p.match_session_id,
            policy_id: p.policy_id,
            holder_token: p.holder_token,
            window: { ...p.window },
            revoked: null,
            persons: new Map(), // person_token -> {relationship, terms:[{term_id, spot_id, total}]}
            adjustments: [],
            created_at: e.occurred_at,
          }),
        );
        addTerms(acc, p.holder_token, "HOLDER", initialTerms(rm.policies.get(p.policy_id), e));
        const tlist = rm.accountsByTicket.get(p.ticket_id) ?? [];
        tlist.push(e.aggregate_id);
        rm.accountsByTicket.set(p.ticket_id, tlist);
        break;
      }
      case "BENEFIT_COMPANION_LINKED": {
        const acc = rm.accounts.get(e.aggregate_id);
        if (acc) addTerms(acc, p.person_token, p.relationship, p.terms);
        break;
      }
      case "BENEFIT_REVOKED": {
        const acc = rm.accounts.get(e.aggregate_id);
        if (acc) {
          acc.revoked = {
            reason_code: p.reason_code,
            upstream_event_id: p.upstream_event_id,
            holder_token: p.holder_token ?? null,
            at: e.occurred_at,
            note: p.note,
          };
        }
        break;
      }
      case "BENEFIT_ADJUSTED": {
        const acc = rm.accounts.get(e.aggregate_id);
        if (acc) {
          if (p.holder_token) acc.holder_token = p.holder_token;
          if (p.window) acc.window = { ...p.window };
          for (const g of p.quota_grants ?? []) {
            const term_id = `tg_${e.event_id}_${g.person_token.slice(-8)}_${g.spot_id ?? "GLOBAL"}`;
            addTerms(acc, g.person_token, currentRelationship(acc, g.person_token), [
              { term_id, spot_id: g.spot_id, total: g.amount },
            ]);
          }
          for (const r of p.quota_revokes ?? []) {
            revokeQuota(acc, r.person_token, r.spot_id, r.amount);
          }
          acc.adjustments.push({ event_id: e.event_id, reason_code: p.reason_code, at: e.occurred_at });
        }
        break;
      }
      case "SPOT_REGISTERED": {
        rm.spots.set(e.aggregate_id, {
          id: e.aggregate_id,
          name: p.name,
          windows: p.windows ?? [],
          closures: [],
          remote_offline_allowed: p.remote_offline_allowed ?? false,
        });
        break;
      }
      case "SPOT_WINDOWS_UPDATED": {
        const s = rm.spots.get(e.aggregate_id);
        if (s) s.windows = p.windows;
        break;
      }
      case "SPOT_CLOSED": {
        const s = rm.spots.get(e.aggregate_id);
        if (s) s.closures.push({ from: p.from, to: p.to, reason: p.reason });
        break;
      }
      case "DEVICE_REGISTERED": {
        rm.devices.set(p.device_id, {
          device_id: p.device_id,
          spot_id: p.spot_id,
          public_key_hint: p.public_key_hint,
          offline_quota: p.offline_quota,
        });
        break;
      }
      case "REDEMPTION_PENDING": {
        rm.proofs.set(e.aggregate_id, {
          id: e.aggregate_id,
          status: "PENDING",
          ...e.payload,
          pending_event_id: e.event_id,
        });
        break;
      }
      case "REDEMPTION_CAPTURED": {
        const proof = upsert(rm.proofs, e.aggregate_id, () => ({ id: e.aggregate_id }));
        Object.assign(proof, e.payload, {
          id: e.aggregate_id,
          status: "CAPTURED",
          captured_event_id: e.event_id,
        });
        break;
      }
      case "REDEMPTION_REJECTED": {
        const proof = { id: e.aggregate_id, status: "REJECTED", ...e.payload, rejected_event_id: e.event_id };
        rm.proofs.set(e.aggregate_id, proof);
        rm.rejections.push(proof);
        break;
      }
      case "REDEMPTION_VOIDED": {
        const proof = rm.proofs.get(e.aggregate_id);
        if (proof) {
          proof.status = "VOIDED";
          proof.void_reason = p.reason_code;
          proof.void_note = p.note;
          proof.void_event_id = e.event_id;
        }
        break;
      }
      case "APPEAL_FILED": {
        rm.appeals.set(e.aggregate_id, {
          id: e.aggregate_id,
          status: "OPEN",
          ...e.payload,
          filed_event_id: e.event_id,
          filed_at: e.occurred_at,
        });
        break;
      }
      case "APPEAL_RESOLVED": {
        const a = rm.appeals.get(e.aggregate_id);
        if (a) Object.assign(a, p, { status: p.decision, resolved_at: e.occurred_at });
        break;
      }
      case "CLEARING_BATCH_OPENED": {
        rm.batches.set(e.aggregate_id, {
          id: e.aggregate_id,
          status: "OPEN",
          ...e.payload,
          opened_at: e.occurred_at,
          entry_ids: [],
        });
        break;
      }
      case "CLAIM_SETTLED": {
        const entry = {
          id: e.aggregate_id,
          status: "SETTLED",
          ...e.payload,
          settled_event_id: e.event_id,
        };
        rm.entries.set(e.aggregate_id, entry);
        rm.batches.get(p.batch_id)?.entry_ids.push(e.aggregate_id);
        rm.entryByRedemption.set(p.redemption_event_id, e.aggregate_id);
        break;
      }
      case "ENTRY_REVERSED": {
        const entry = rm.entries.get(e.aggregate_id);
        if (entry) {
          entry.status = "REVERSED";
          entry.reversal = { ...e.payload, reversed_event_id: e.event_id, at: e.occurred_at };
        }
        rm.entryByRedemption.delete(entry?.redemption_event_id);
        break;
      }
      case "CLEARING_BATCH_CLOSED": {
        const b = rm.batches.get(e.aggregate_id);
        if (b) {
          b.status = "CLOSED";
          b.totals = {
            total_cents: p.total_cents,
            reversal_cents: p.reversal_cents,
            net_cents: p.net_cents,
            entry_count: p.entry_count,
          };
          b.closed_at = p.closed_at;
        }
        break;
      }
      default:
        break;
    }
  }

  return rm;
}

function currentRelationship(acc, personToken) {
  return acc.persons.get(personToken)?.relationship ?? "HOLDER";
}

/**
 * 按剩余次数扣减某人的额度（转赠/作废）。只动总额度，已消费核销记录保持不变；
 * 因此“转赠、退款只影响尚未消费的对应权利”。
 */
function revokeQuota(acc, personToken, spotId, amount) {
  const person = acc.persons.get(personToken);
  if (!person) return;
  const policyGlobal = spotId === null;
  let left = amount;
  const terms = person.terms
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => (policyGlobal ? t.spot_id === null : t.spot_id === spotId))
    .sort((a, b) => b.t.total - a.t.total);
  for (const { t } of terms) {
    if (left <= 0) break;
    const take = Math.min(t.total, left);
    t.total -= take;
    left -= take;
  }
}

function addTerms(acc, personToken, relationship, terms) {
  const person = acc.persons.get(personToken) ?? { relationship, terms: [] };
  person.relationship = relationship;
  for (const t of terms) {
    if (!person.terms.some((x) => x.term_id === t.term_id)) person.terms.push({ ...t });
  }
  acc.persons.set(personToken, person);
}

function initialTerms(policy, grantEvent) {
  const eid = grantEvent.event_id;
  if (policy.redemption_scope === "GLOBAL") {
    return [{ term_id: `tm_${eid}`, spot_id: null, total: policy.max_total }];
  }
  return policy.spot_terms.map((term, i) => ({
    term_id: `tm_${eid}_${i}`,
    spot_id: term.spot_id,
    total: policy.max_per_spot,
  }));
}

/** 同伴权利项：按政策范围给出各景区/全局额度。 */
export function companionTerms(policy, personToken, linkEventId) {
  if (policy.redemption_scope === "GLOBAL") {
    return [{ term_id: `tc_${linkEventId}`, spot_id: null, total: policy.max_total }];
  }
  return policy.spot_terms.map((term, i) => ({
    term_id: `tc_${linkEventId}_${i}`,
    spot_id: term.spot_id,
    total: policy.max_per_spot,
  }));
}

/**
 * 某账户中某人在某景区的剩余次数。
 * PER_SPOT：该景区权利项总额 − 该景区已核销；GLOBAL：全局总额 − 全部景区已核销。
 * 已作废旧凭证（VOIDED）与待同步（PENDING）不计入。
 */
export function remainingFor(rm, account, personToken, spotId) {
  const person = account.persons.get(personToken);
  if (!person) return { total: 0, used: 0, remaining: 0, terms: [] };
  const policy = rm.policies.get(account.policy_id);
  const applicable =
    policy?.redemption_scope === "GLOBAL"
      ? person.terms.filter((t) => t.spot_id === null)
      : person.terms.filter((t) => t.spot_id === spotId);
  const total = applicable.reduce((s, t) => s + t.total, 0);

  const used = [...rm.proofs.values()].filter(
    (x) =>
      x.status === "CAPTURED" &&
      x.account_id === account.id &&
      x.person_token === personToken &&
      (policy?.redemption_scope === "GLOBAL" || x.spot_id === spotId),
  ).length;

  return { total, used, remaining: Math.max(0, total - used), terms: applicable };
}

/** 该账户全部已核销凭证，按业务发生时间、设备序号排序（离线合并的时间线）。 */
export function capturedTimeline(rm, accountId) {
  return [...rm.proofs.values()]
    .filter((x) => x.status === "CAPTURED" && x.account_id === accountId)
    .sort((a, b) => {
      const t =
        new Date(a.occurred_on_device_at) - new Date(b.occurred_on_device_at) ||
        (a.device_seq ?? 0) - (b.device_seq ?? 0) ||
        a.id.localeCompare(b.id);
      return t;
    });
}
