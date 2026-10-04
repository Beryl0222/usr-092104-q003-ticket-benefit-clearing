/**
 * 测试夹具：可控时钟 + 标准目录（1 场比赛、若干景区、PER_SPOT/GLOBAL 两版政策、设备）。
 */
import { EventStore } from "../src/kernel/event-store.js";
import { createApp } from "../src/app.js";

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7];
export const DAILY = [{ weekdays: WEEKDAYS, open: "08:00", close: "18:00" }];

export function setupWorld(opts = {}) {
  const clock = { t: new Date(opts.start ?? "2026-09-25T09:00:00+08:00") };
  const store = new EventStore({ clock: () => clock.t });
  const app = createApp({ store, now: () => clock.t });
  return { app, clock, setClock: (iso) => (clock.t = new Date(iso)), store };
}

export function registerStandardCatalog(app, { spotCount = 6, scope = "PER_SPOT" } = {}) {
  const { catalog } = app;
  const match = catalog.scheduleMatch({
    match_code: "M-1",
    home_team: "永州湘超",
    away_team: "客队",
    kicks_off_at: "2026-10-10T19:30:00+08:00",
    venue: "永州体育中心",
  });
  const spotIds = [];
  for (let i = 1; i <= spotCount; i++) {
    const id = `spot${String(i).padStart(2, "0")}`;
    spotIds.push(id);
    catalog.registerSpot({ spot_id: id, name: `景区${i}`, windows: DAILY, remote_offline_allowed: true });
  }
  const policy = catalog.publishPolicy({
    policy_code: "P-STD",
    policy_version: 1,
    effective_from: "2026-09-01T00:00:00+08:00",
    effective_to: "2026-12-31T23:59:59+08:00",
    match_window: { relative_to: "KICKOFF", start_offset_hours: -72, end_offset_hours: 168 },
    redemption_scope: scope,
    max_per_spot: 1,
    max_total: 2,
    companions_allowed: true,
    max_companions: 3,
    spot_terms: spotIds.map((spot_id) => ({ spot_id, agreed_price_cents: 5000, requires_nomination: false })),
  });
  return { match, spotIds, policy };
}

export function registerDevice(app, spotId, offline_quota = 5) {
  return app.devices.registerDevice({ spot_id: spotId, offline_quota });
}
