/**
 * 不透明标识与设备签名。
 * 游客对各渠道呈现的是 HMAC 令牌而非身份信息；景区/清算侧无法据令牌反查个人。
 */
import crypto from "node:crypto";

export function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function sha256(input) {
  return crypto.createHash("sha256").update(input).digest("hex");
}

/**
 * 由自然键确定性派生不透明令牌：同一人在不同 scope 下令牌不同，
 * 避免景区之间凭令牌串联游客行程；持票人 scope 固定，保证各景区能识别同一持票人。
 */
export function deriveToken(secret, scope, naturalKey) {
  const digest = crypto.createHmac("sha256", secret).update(`${scope}|${naturalKey}`).digest("hex");
  return `tk_${scope}_${digest.slice(0, 24)}`;
}

/** 离线终端对凭证载荷签名；密钥按设备预置，不在事件中出现。 */
export function signPayload(deviceSecret, canonicalJson) {
  return crypto.createHmac("sha256", deviceSecret).update(canonicalJson).digest("hex");
}

export function verifySignature(deviceSecret, canonicalJson, signature) {
  if (typeof signature !== "string") return false;
  const expected = signPayload(deviceSecret, canonicalJson);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** 凭证待签名的规范化串：字段固定顺序，杜绝重排伪造（离线凭证只含景区假名）。 */
export function canonicalPendingPayload(p) {
  return JSON.stringify([
    p.proof_id,
    p.device_id,
    p.spot_id,
    p.account_ref,
    p.person_ref,
    p.benefit_term_id,
    p.occurred_on_device_at,
    p.device_seq,
  ]);
}
