/**
 * 核销设备登记与离线密钥管理。
 * DEVICE_REGISTERED 事件只记录设备身份与绑定景区；HMAC 密钥带外分发、不进事件流。
 */
import crypto from "node:crypto";
import { randomId } from "../kernel/ids.js";
import { iso } from "../kernel/clock.js";
import { buildReadModel } from "../projections/read-model.js";

export function createDeviceRegistry({ store, now = () => new Date() }) {
  // 实际部署中由密钥管理系统托管；内存映射仅用于联调与测试。
  const secrets = new Map();

  function registerDevice({ spot_id, offline_quota = 0 }) {
    const model = buildReadModel(store);
    if (!model.spots.has(spot_id)) throw new Error(`设备绑定的景区不存在：${spot_id}`);
    const device_id = randomId("dev");
    const secret = crypto.randomBytes(32).toString("hex");
    secrets.set(device_id, secret);
    store.commit([
      {
        event_type: "DEVICE_REGISTERED",
        aggregate_type: "terminal_device",
        aggregate_id: device_id,
        occurred_at: iso(now()),
        summary: `登记核销设备 ${device_id}，绑定景区 ${spot_id}`,
        payload: {
          device_id,
          spot_id,
          public_key_hint: crypto.createHash("sha256").update(secret).digest("hex").slice(0, 12),
          offline_quota,
        },
      },
    ]);
    return { device_id, secret };
  }

  function getSecret(deviceId) {
    return secrets.get(deviceId) ?? null;
  }

  function importDeviceSecret(deviceId, secret) {
    secrets.set(deviceId, secret);
  }

  return { registerDevice, getSecret, importDeviceSecret };
}
