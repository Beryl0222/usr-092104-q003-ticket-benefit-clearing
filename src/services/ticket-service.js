/**
 * 票务服务：纸票/电子票/赠票确认、记名、转赠、赛后退票、作废，以及比赛延期联动。
 * 票务状态变化与权益变化在同一事件批次提交：
 * - 转赠：剩余权利随账户转移，已核销记录留在原账户时间线上不变；
 * - 退款/作废：只冻结剩余权利，已消费部分继续参与清算；
 * - 延期：权益窗口整体平移，不回滚已发生核销。
 */
import { randomId, deriveToken } from "../kernel/ids.js";
import { iso, windowAroundKickoff, shiftWindow } from "../kernel/clock.js";
import { buildReadModel } from "../projections/read-model.js";

export function createTicketService({ store, tokenSecret, now = () => new Date() }) {
  const rm = () => buildReadModel(store);
  const tokenOf = (key) => deriveToken(tokenSecret, "holder", key);

  function confirmTicket({ match_session_id, serial, media, holder_key, policy_id }) {
    const model = rm();
    if (model.ticketsBySerial.has(serial)) throw new Error(`票号已存在：${serial}`);
    const match = model.matches.get(match_session_id);
    if (!match) throw new Error(`场次不存在：${match_session_id}`);
    const policy = model.policies.get(policy_id);
    if (!policy) throw new Error(`政策版本不存在：${policy_id}`);

    const ticketId = randomId("tkt");
    const accountId = randomId("acc");
    const holder_token = tokenOf(holder_key ?? serial);
    const window = windowAroundKickoff(match.kicks_off_at, policy.match_window);
    const at = iso(now());

    const drafts = [
      {
        event_type: "TICKET_CONFIRMED",
        aggregate_type: "match_ticket",
        aggregate_id: ticketId,
        occurred_at: at,
        summary: `${mediaLabel(media)}确认：${serial}`,
        payload: {
          match_session_id,
          serial,
          media,
          holder_token,
          // 电子票购票即记名；纸票、赠票需后续现场记名。
          nominated: media === "ELECTRONIC",
          issued_at: at,
        },
      },
      {
        event_type: "BENEFIT_GRANTED",
        aggregate_type: "benefit_account",
        aggregate_id: accountId,
        occurred_at: at,
        summary: `票根 ${serial} 按 ${policy.policy_code} v${policy.policy_version} 授予权益`,
        payload: {
          ticket_id: ticketId,
          match_session_id,
          policy_id,
          holder_token,
          companion_tokens: [],
          window,
        },
      },
    ];
    store.commit(drafts, { correlationId: `grant_${ticketId}` });
    return { ticket_id: ticketId, account_id: accountId, holder_token };
  }

  /** 纸票/赠票现场记名：持票人令牌更换，未消费额度平移到新令牌。 */
  function nominateTicket(ticketId, { holder_key, channel = "ON_SITE" }) {
    return changeHolder(ticketId, { holder_key, kind: "NOMINATE", channel });
  }

  /** 转赠：尚未消费的对应权利转给新持票人。 */
  function transferTicket(ticketId, { holder_key, note = "票根转赠" }) {
    return changeHolder(ticketId, { holder_key, kind: "TRANSFER", note });
  }

  function changeHolder(ticketId, { holder_key, kind, channel, note }) {
    const model = rm();
    const ticket = model.tickets.get(ticketId);
    if (!ticket) throw new Error(`票不存在：${ticketId}`);
    if (["REFUNDED", "INVALIDATED"].includes(ticket.status)) {
      throw new Error(`票状态为 ${ticket.status}，不能${kind === "NOMINATE" ? "记名" : "转赠"}`);
    }
    const accountId = activeAccountId(model, ticketId);
    const account = model.accounts.get(accountId);
    const newToken = tokenOf(holder_key);
    if (newToken === account.holder_token) throw new Error("新持票人与当前持票人相同");

    const drafts = [];
    if (kind === "NOMINATE") {
      drafts.push({
        event_type: "TICKET_NOMINATED",
        aggregate_type: "match_ticket",
        aggregate_id: ticketId,
        summary: `票根 ${ticket.serial} 记名`,
        payload: { holder_token: newToken, channel },
      });
    } else {
      drafts.push({
        event_type: "TICKET_TRANSFERRED",
        aggregate_type: "match_ticket",
        aggregate_id: ticketId,
        summary: `票根 ${ticket.serial} 转赠`,
        payload: { from_holder_token: account.holder_token, to_holder_token: newToken, note },
      });
    }

    const { quota_revokes, quota_grants } = moveQuota(model, account, account.holder_token, newToken);
    drafts.push({
      event_type: "BENEFIT_ADJUSTED",
      aggregate_type: "benefit_account",
      aggregate_id: accountId,
      summary: kind === "NOMINATE" ? "记名：剩余权利平移至记名持票人" : "转赠：剩余权利转移，已消费记录不变",
      payload: {
        reason_code: "TICKET_TRANSFERRED",
        holder_token: newToken,
        quota_grants,
        quota_revokes,
        upstream_event_id: "", // 与票务事件同批，提交后由调用链关联 correlation_id
      },
    });
    store.commit(drafts, { correlationId: `holder_${ticketId}` });
    return { ticket_id: ticketId, account_id: accountId, holder_token: newToken };
  }

  function refundTicket(ticketId, { reason = "赛后退票", refunded_at } = {}) {
    return settleTicket(ticketId, { reason, at: refunded_at, refund: true });
  }

  function invalidateTicket(ticketId, { reason = "防伪核验失败" }) {
    return settleTicket(ticketId, { reason, refund: false });
  }

  function settleTicket(ticketId, { reason, at, refund }) {
    const model = rm();
    const ticket = model.tickets.get(ticketId);
    if (!ticket) throw new Error(`票不存在：${ticketId}`);
    if (["REFUNDED", "INVALIDATED"].includes(ticket.status)) {
      throw new Error(`票已处于终态：${ticket.status}`);
    }
    const accountId = activeAccountId(model, ticketId);
    const ticketEventId = randomId("evt");
    const drafts = [
      refund
        ? {
            event_type: "TICKET_REFUNDED",
            aggregate_type: "match_ticket",
            aggregate_id: ticketId,
            event_id: ticketEventId,
            summary: `票根 ${ticket.serial} 退票（赛后）`,
            payload: { refunded_at: iso(at ?? now()), reason },
          }
        : {
            event_type: "TICKET_INVALIDATED",
            aggregate_type: "match_ticket",
            aggregate_id: ticketId,
            event_id: ticketEventId,
            summary: `票根 ${ticket.serial} 作废：${reason}`,
            payload: { reason },
          },
      {
        event_type: "BENEFIT_REVOKED",
        aggregate_type: "benefit_account",
        aggregate_id: accountId,
        summary: refund ? "退票：冻结尚未消费的权利，已核销部分照常清算" : "作废：冻结剩余权利",
        payload: {
          reason_code: refund ? "TICKET_REFUNDED" : "TICKET_INVALIDATED",
          upstream_event_id: ticketEventId,
          note: reason,
        },
      },
    ];
    store.commit(drafts, { correlationId: `settle_${ticketId}` });
    return { ticket_id: ticketId, account_id: accountId };
  }

  /** 比赛延期：窗口按开赛时间差平移，仅作用于未终结账户；历史核销不动。 */
  function postponeMatch(matchSessionId, { new_kicks_off_at, reason }) {
    const model = rm();
    const match = model.matches.get(matchSessionId);
    if (!match) throw new Error(`场次不存在：${matchSessionId}`);
    const drafts = [
      {
        event_type: "MATCH_POSTPONED",
        aggregate_type: "match_session",
        aggregate_id: matchSessionId,
        summary: `场次 ${match.match_code} 延期至 ${new_kicks_off_at}`,
        payload: {
          original_kicks_off_at: match.kicks_off_at,
          new_kicks_off_at,
          reason,
        },
      },
    ];
    for (const account of model.accounts.values()) {
      if (account.match_session_id !== matchSessionId || account.revoked) continue;
      drafts.push({
        event_type: "BENEFIT_ADJUSTED",
        aggregate_type: "benefit_account",
        aggregate_id: account.id,
        summary: "比赛延期：权益窗口平移，已消费核销不回滚",
        payload: {
          reason_code: "MATCH_POSTPONED",
          window: shiftWindow(account.window, match.kicks_off_at, new_kicks_off_at),
          quota_grants: [],
          upstream_event_id: "",
        },
      });
    }
    store.commit(drafts, { correlationId: `postpone_${matchSessionId}` });
  }

  return { confirmTicket, nominateTicket, transferTicket, refundTicket, invalidateTicket, postponeMatch };
}

function activeAccountId(model, ticketId) {
  const list = model.accountsByTicket.get(ticketId);
  if (!list || list.length === 0) throw new Error(`票根 ${ticketId} 没有权益账户`);
  return list[list.length - 1];
}

/** 计算旧持票人各权利项的剩余次数，构造“扣旧+补新”的调整载荷。 */
function moveQuota(model, account, fromToken, toToken) {
  const policy = model.policies.get(account.policy_id);
  const quota_revokes = [];
  const quota_grants = [];
  const person = account.persons.get(fromToken);
  if (!person) return { quota_revokes, quota_grants };
  for (const term of person.terms) {
    const used = [...model.proofs.values()].filter(
      (x) =>
        x.status === "CAPTURED" &&
        x.account_id === account.id &&
        x.person_token === fromToken &&
        (policy.redemption_scope === "GLOBAL" || x.spot_id === term.spot_id),
    ).length;
    const remaining = Math.max(0, term.total - used);
    if (remaining <= 0) continue;
    quota_revokes.push({ person_token: fromToken, spot_id: term.spot_id, amount: remaining });
    quota_grants.push({ person_token: toToken, spot_id: term.spot_id, amount: remaining });
  }
  return { quota_revokes, quota_grants };
}

function mediaLabel(media) {
  return { PAPER: "纸票", ELECTRONIC: "电子票", COMPLIMENTARY: "赠票" }[media] ?? media;
}
