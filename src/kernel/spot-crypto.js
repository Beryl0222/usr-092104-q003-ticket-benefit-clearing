/**
 * 景区条目加密封装。
 * 凭证中每个景区的条目用该景区专属对称密钥做 AES-256-GCM 加密：
 * 终端只预置本景区密钥，只能解开本景区条目，无法读取其他景区（更无法从条目缺失推断游客去过哪里）。
 * 景区密钥由平台主密钥派生，带外分发到对应景区终端。
 */
import crypto from "node:crypto";

export function spotKey(masterSecret, spotId) {
  return crypto.createHmac("sha256", masterSecret).update(`spot-key:${spotId}`).digest(); // 32 字节
}

export function encryptJson(key, obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString("base64url"),
    data: data.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

export function decryptJson(key, box) {
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(box.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64url"));
    const raw = Buffer.concat([
      decipher.update(Buffer.from(box.data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
