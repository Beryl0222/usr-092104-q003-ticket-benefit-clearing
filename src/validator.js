/** 领域事件信封基础校验（无第三方依赖）。枚举与 contracts/domain.schema.json 保持一致。 */

const required = ["event_id", "event_type", "aggregate_type", "aggregate_id", "occurred_at", "version", "summary"];

export const eventTypes = [
  "MATCH_SCHEDULED",
  "MATCH_POSTPONED",
  "TICKET_CONFIRMED",
  "TICKET_NOMINATED",
  "TICKET_TRANSFERRED",
  "TICKET_REFUNDED",
  "TICKET_INVALIDATED",
  "POLICY_PUBLISHED",
  "BENEFIT_GRANTED",
  "BENEFIT_COMPANION_LINKED",
  "BENEFIT_REVOKED",
  "BENEFIT_ADJUSTED",
  "SPOT_REGISTERED",
  "SPOT_WINDOWS_UPDATED",
  "SPOT_CLOSED",
  "DEVICE_REGISTERED",
  "REDEMPTION_PENDING",
  "REDEMPTION_CAPTURED",
  "REDEMPTION_REJECTED",
  "REDEMPTION_VOIDED",
  "APPEAL_FILED",
  "APPEAL_RESOLVED",
  "CLEARING_BATCH_OPENED",
  "CLAIM_SETTLED",
  "ENTRY_REVERSED",
  "CLEARING_BATCH_CLOSED",
];

export const aggregateTypes = [
  "match_session",
  "match_ticket",
  "benefit_policy",
  "benefit_account",
  "scenic_spot",
  "terminal_device",
  "redemption_proof",
  "benefit_appeal",
  "clearing_batch",
  "clearing_entry",
];

/** 事件类型允许的聚合类型。 */
const aggregateForEvent = {
  MATCH_SCHEDULED: "match_session",
  MATCH_POSTPONED: "match_session",
  TICKET_CONFIRMED: "match_ticket",
  TICKET_NOMINATED: "match_ticket",
  TICKET_TRANSFERRED: "match_ticket",
  TICKET_REFUNDED: "match_ticket",
  TICKET_INVALIDATED: "match_ticket",
  POLICY_PUBLISHED: "benefit_policy",
  BENEFIT_GRANTED: "benefit_account",
  BENEFIT_COMPANION_LINKED: "benefit_account",
  BENEFIT_REVOKED: "benefit_account",
  BENEFIT_ADJUSTED: "benefit_account",
  SPOT_REGISTERED: "scenic_spot",
  SPOT_WINDOWS_UPDATED: "scenic_spot",
  SPOT_CLOSED: "scenic_spot",
  DEVICE_REGISTERED: "terminal_device",
  REDEMPTION_PENDING: "redemption_proof",
  REDEMPTION_CAPTURED: "redemption_proof",
  REDEMPTION_REJECTED: "redemption_proof",
  REDEMPTION_VOIDED: "redemption_proof",
  APPEAL_FILED: "benefit_appeal",
  APPEAL_RESOLVED: "benefit_appeal",
  CLEARING_BATCH_OPENED: "clearing_batch",
  CLAIM_SETTLED: "clearing_entry",
  ENTRY_REVERSED: "clearing_entry",
  CLEARING_BATCH_CLOSED: "clearing_batch",
};

export function validateEvent(record) {
  const errors = required.filter((name) => !(name in record)).map((name) => `缺少字段：${name}`);
  if ("version" in record && (!Number.isInteger(record.version) || record.version < 1)) {
    errors.push("version 必须是正整数");
  }
  if ("event_id" in record && (typeof record.event_id !== "string" || record.event_id.length === 0)) {
    errors.push("event_id 必须是非空字符串");
  }
  if ("event_type" in record && !eventTypes.includes(record.event_type)) {
    errors.push(`未知 event_type：${record.event_type}`);
  }
  if ("aggregate_type" in record && !aggregateTypes.includes(record.aggregate_type)) {
    errors.push(`未知 aggregate_type：${record.aggregate_type}`);
  }
  if (
    "event_type" in record &&
    "aggregate_type" in record &&
    aggregateForEvent[record.event_type] &&
    aggregateForEvent[record.event_type] !== record.aggregate_type
  ) {
    errors.push(
      `${record.event_type} 的聚合必须是 ${aggregateForEvent[record.event_type]}，实际为 ${record.aggregate_type}`,
    );
  }
  if ("occurred_at" in record && Number.isNaN(Date.parse(record.occurred_at))) {
    errors.push("occurred_at 必须是合法 date-time");
  }
  return errors;
}
