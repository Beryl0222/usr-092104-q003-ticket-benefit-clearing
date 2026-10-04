/**
 * 应用装配根：事件存储 + 密钥 + 各领域服务。
 * 密钥仅在平台侧存在；景区终端只拿到设备密钥与本景区密钥（见 terminalKeys/offlineTerminal）。
 */
import { EventStore } from "./kernel/event-store.js";
import { spotKey } from "./kernel/spot-crypto.js";
import { buildReadModel } from "./projections/read-model.js";
import { createCatalogService } from "./services/catalog-service.js";
import { createDeviceRegistry } from "./services/device-registry.js";
import { createTicketService } from "./services/ticket-service.js";
import { createBenefitService } from "./services/benefit-service.js";
import { createWalletService } from "./services/wallet-service.js";
import { createRedemptionService } from "./services/redemption-service.js";
import { createOfflineTerminal } from "./services/offline-terminal.js";
import { createSyncService } from "./services/sync-service.js";
import { createAppealService } from "./services/appeal-service.js";
import { createClearingService } from "./services/clearing-service.js";
import { createAuditService } from "./services/audit-service.js";
import { createViews } from "./views/views.js";

export function createApp({ secrets, store: incomingStore, now } = {}) {
  const clock = now ?? (() => new Date());
  const tokenSecret = secrets?.tokenSecret ?? "dev-token-secret";
  const voucherSecret = secrets?.voucherSecret ?? "dev-voucher-secret";
  const spotMasterSecret = secrets?.spotMasterSecret ?? "dev-spot-master-secret";

  const store = incomingStore ?? new EventStore({ clock });

  const devices = createDeviceRegistry({ store, now });
  const catalog = createCatalogService({ store, now });
  const benefits = createBenefitService({ store, tokenSecret, now });
  const tickets = createTicketService({ store, tokenSecret, now });
  const wallet = createWalletService({ store, tokenSecret, voucherSecret, spotMasterSecret });
  const redemption = createRedemptionService({
    store,
    deviceRegistry: devices,
    tokenSecret,
    platformSecret: voucherSecret,
    spotMasterSecret,
    now,
  });
  const sync = createSyncService({ store, deviceRegistry: devices, tokenSecret, now });
  const appeals = createAppealService({ store, benefitService: benefits, now });
  const clearing = createClearingService({ store, benefitService: benefits, now });
  const audit = createAuditService({ store });
  const views = createViews({ store, tokenSecret });

  /** 为某设备构造离线终端（终端只持有自身密钥与本景区密钥）。 */
  function offlineTerminal(deviceId, { clock } = {}) {
    const device = buildReadModel(store).devices.get(deviceId);
    if (!device) throw new Error(`设备不存在：${deviceId}`);
    return createOfflineTerminal({
      device,
      deviceSecret: devices.getSecret(deviceId),
      platformSecret: voucherSecret,
      spotMasterSecret,
      clock,
    });
  }

  /** 终端预置密钥材料：设备签名密钥 + 仅本景区的条目解密密钥。 */
  function terminalKeys(deviceId) {
    const device = buildReadModel(store).devices.get(deviceId);
    if (!device) throw new Error(`设备不存在：${deviceId}`);
    return {
      device_id: deviceId,
      spot_id: device.spot_id,
      device_secret: devices.getSecret(deviceId),
      spot_key: spotKey(spotMasterSecret, device.spot_id).toString("base64url"),
    };
  }

  return {
    store,
    secrets: { tokenSecret, voucherSecret, spotMasterSecret },
    catalog,
    devices,
    tickets,
    benefits,
    wallet,
    redemption,
    sync,
    appeals,
    clearing,
    audit,
    views,
    offlineTerminal,
    terminalKeys,
  };
}
