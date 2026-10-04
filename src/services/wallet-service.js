/**
 * 游客钱包：签发离线可验、逐景区加密的权益凭证。
 * 隐私要点：
 * - 信封只含政策版本、范围与窗口，由平台签名；不含姓名、票号、持票人全局令牌；
 * - 每个协议景区一个独立加密条目，仅该景区密钥可解：终端读不到其他景区是否有条目，无法串联行程；
 * - 条目内为该景区专属假名（account_ref/person_ref）与剩余次数，核验所需最小信息。
 */
import { issueEntitlement, sealSpotEntry } from "../kernel/entitlement.js";
import { spotAccountPseudonym, spotPersonPseudonym } from "../kernel/pseudonyms.js";
import { buildReadModel, remainingFor } from "../projections/read-model.js";

export function createWalletService({ store, tokenSecret, voucherSecret, spotMasterSecret }) {
  function issueVoucher(accountId, { person_token } = {}) {
    const model = buildReadModel(store);
    const account = model.accounts.get(accountId);
    if (!account) throw new Error(`权益账户不存在：${accountId}`);
    const token = person_token ?? account.holder_token;
    const person = account.persons.get(token);
    if (!person) throw new Error("该人与权益账户无关联");
    if (account.revoked) throw new Error("账户剩余权利已冻结");
    const policy = model.policies.get(account.policy_id);

    const spots = {};
    for (const spotTerm of policy.spot_terms) {
      const queriedSpotId = policy.redemption_scope === "GLOBAL" ? null : spotTerm.spot_id;
      const left = remainingFor(model, account, token, queriedSpotId);
      const termId =
        policy.redemption_scope === "GLOBAL"
          ? left.terms.find((t) => t.spot_id === null)?.term_id ?? null
          : left.terms.find((t) => t.spot_id === spotTerm.spot_id)?.term_id ?? null;
      const entry = {
        account_ref: spotAccountPseudonym(tokenSecret, spotTerm.spot_id, accountId),
        person_ref: spotPersonPseudonym(tokenSecret, spotTerm.spot_id, token),
        relationship: person.relationship,
        scope: policy.redemption_scope,
        term_id: termId,
        remaining: left.remaining,
      };
      spots[spotTerm.spot_id] = sealSpotEntry(spotMasterSecret, spotTerm.spot_id, entry);
    }

    return issueEntitlement(voucherSecret, {
      policy_id: account.policy_id,
      scope: policy.redemption_scope,
      window: account.window,
      spots,
      iat: new Date().toISOString(),
    });
  }

  return { issueVoucher };
}
