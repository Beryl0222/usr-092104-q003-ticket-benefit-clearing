/**
 * 游客权益凭证（离线条码/二维码内容）。
 * 结构：平台对信封整体签名（终端可离线验证确系平台签发），各景区条目独立加密（见 spot-crypto）。
 */
import { signPayload, verifySignature } from "./ids.js";
import { spotKey, encryptJson, decryptJson } from "./spot-crypto.js";

export function issueEntitlement(platformSecret, body) {
  const payload = Buffer.from(JSON.stringify({ iss: "ticket-benefit-clearing", ...body }), "utf8").toString(
    "base64url",
  );
  const sig = signPayload(platformSecret, payload);
  return `${payload}.${sig}`;
}

/** 仅验签并返回信封（条目仍为密文）。 */
export function openEntitlement(platformSecret, voucher) {
  const [payload, sig] = String(voucher).split(".");
  if (!payload || !sig || !verifySignature(platformSecret, payload, sig)) return null;
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/** 钱包端：把某景区条目加密进信封。 */
export function sealSpotEntry(masterSecret, spotId, entry) {
  return encryptJson(spotKey(masterSecret, spotId), entry);
}

/** 终端端：解开本景区条目（密钥不符/篡改返回 null）。 */
export function openSpotEntry(masterSecret, spotId, box) {
  return decryptJson(spotKey(masterSecret, spotId), box);
}
