/**
 * 时间与营业窗口工具。
 * 权益窗口锚点开赛时间（MATCH_POSTPONED 时整体平移）；景区营业按本地（+08:00）周历与闭园区间判定。
 */

const LOCAL_OFFSET_MIN = 8 * 60; // 湖南景区均使用北京时间，无夏令时

function toDate(input) {
  return input instanceof Date ? input : new Date(input);
}

export function iso(input = new Date()) {
  return toDate(input).toISOString();
}

function localParts(d, offsetMin = LOCAL_OFFSET_MIN) {
  const shifted = new Date(d.getTime() + offsetMin * 60_000);
  return {
    // ISO 周历：周一=1 … 周日=7
    weekday: ((shifted.getUTCDay() + 6) % 7) + 1,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function hhmmToMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** 开赛锚点窗口：start/end 为相对开赛的小时偏移，可为负。 */
export function windowAroundKickoff(kickoffAt, matchWindow) {
  const k = toDate(kickoffAt).getTime();
  return {
    from: new Date(k + matchWindow.start_offset_hours * 3_600_000).toISOString(),
    to: new Date(k + matchWindow.end_offset_hours * 3_600_000).toISOString(),
  };
}

/** 比赛延期：窗口整体平移相同的开赛时间差。 */
export function shiftWindow(window, oldKickoffAt, newKickoffAt) {
  const delta = toDate(newKickoffAt).getTime() - toDate(oldKickoffAt).getTime();
  return {
    from: new Date(toDate(window.from).getTime() + delta).toISOString(),
    to: new Date(toDate(window.to).getTime() + delta).toISOString(),
  };
}

export function isBetween(instant, from, to) {
  const t = toDate(instant).getTime();
  return t >= toDate(from).getTime() && t <= toDate(to).getTime();
}

/** 景区是否在某时刻正常营业：先排除临时闭园，再匹配周历营业时段。 */
export function spotOpenAt(spot, instant) {
  const at = toDate(instant);
  for (const closure of spot.closures ?? []) {
    if (isBetween(at, closure.from, closure.to)) return false;
  }
  const parts = localParts(at);
  for (const w of spot.windows ?? []) {
    if (w.from && !isBetween(at, w.from, w.to)) continue;
    if (Array.isArray(w.weekdays) && w.weekdays.length > 0 && !w.weekdays.includes(parts.weekday)) continue;
    const open = hhmmToMinutes(w.open);
    const close = hhmmToMinutes(w.close);
    const cur = parts.hour * 60 + parts.minute;
    if (cur >= open && cur <= close) return true;
  }
  return false;
}

/** 政策版本是否覆盖某时刻（生效区间）。 */
export function policyEffectiveAt(policyRules, instant) {
  const t = toDate(instant).getTime();
  if (t < toDate(policyRules.effective_from).getTime()) return false;
  if (policyRules.effective_to && t > toDate(policyRules.effective_to).getTime()) return false;
  return true;
}
