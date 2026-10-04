/**
 * 分级假名。
 * 同一游客对不同对象呈现不同、不可互推的标识：
 * - 持票人全局令牌：仅游客 App / 平台内部使用，永不进入景区或清算渠道；
 * - 景区假名：同一游客在不同景区的 account/person 假名不同，景区之间无法串联行程；
 * - 清算假名：清算侧稳定标识（跨批次去重/对账），但无法与景区假名或身份互推；
 * 派生均为 HMAC，持有平台密钥的主管部门可在授权追溯时还原映射。
 */
import { deriveToken } from "./ids.js";

export function holderToken(secret, naturalKey) {
  return deriveToken(secret, "holder", naturalKey);
}

export function spotAccountPseudonym(secret, spotId, accountId) {
  return deriveToken(secret, `acct:${spotId}`, accountId);
}

export function spotPersonPseudonym(secret, spotId, globalPersonToken) {
  return deriveToken(secret, `person:${spotId}`, globalPersonToken);
}

export function clearingPseudonym(secret, accountId) {
  return deriveToken(secret, "clearing", accountId);
}

/** 由读模型构建反向解析（仅持密钥的平台服务可用）。 */
export function buildResolver(model, secret) {
  const accountRefs = new Map(); // `${spotId}|${ref}` -> accountId
  const personRefs = new Map(); // `${spotId}|${ref}` -> {accountId, personToken}
  const clearingRefs = new Map(); // ref -> accountId

  for (const account of model.accounts.values()) {
    clearingRefs.set(clearingPseudonym(secret, account.id), account.id);
    // 平台知道设备绑定的全部景区；对每个协议景区派生该账户的假名。
    for (const spotId of model.spots.keys()) {
      accountRefs.set(`${spotId}|${spotAccountPseudonym(secret, spotId, account.id)}`, account.id);
      for (const personToken of account.persons.keys()) {
        personRefs.set(
          `${spotId}|${spotPersonPseudonym(secret, spotId, personToken)}`,
          { accountId: account.id, personToken },
        );
      }
    }
  }

  return {
    resolveAccount(spotId, ref) {
      return accountRefs.get(`${spotId}|${ref}`) ?? null;
    },
    resolvePerson(spotId, ref) {
      return personRefs.get(`${spotId}|${ref}`) ?? null;
    },
    resolveClearing(ref) {
      return clearingRefs.get(ref) ?? null;
    },
  };
}
