/** 领域事件信封：各渠道（票务、景区终端、离线同步、申诉、清算）唯一交换格式。 */
export interface DomainEvent {
  event_id: string;
  event_type: DomainEventType;
  aggregate_type: AggregateType;
  aggregate_id: string;
  occurred_at: string;
  /** 聚合内单调递增版本号。 */
  version: number;
  summary: string;
  payload?: Record<string, unknown>;
  /** 触发本事件的上游事件 ID。 */
  causation_id?: string;
  /** 同一业务流程关联 ID。 */
  correlation_id?: string;
}

export type DomainEventType =
  | "MATCH_SCHEDULED"
  | "MATCH_POSTPONED"
  | "TICKET_CONFIRMED"
  | "TICKET_NOMINATED"
  | "TICKET_TRANSFERRED"
  | "TICKET_REFUNDED"
  | "TICKET_INVALIDATED"
  | "POLICY_PUBLISHED"
  | "BENEFIT_GRANTED"
  | "BENEFIT_COMPANION_LINKED"
  | "BENEFIT_REVOKED"
  | "BENEFIT_ADJUSTED"
  | "SPOT_REGISTERED"
  | "SPOT_WINDOWS_UPDATED"
  | "SPOT_CLOSED"
  | "DEVICE_REGISTERED"
  | "REDEMPTION_PENDING"
  | "REDEMPTION_CAPTURED"
  | "REDEMPTION_REJECTED"
  | "REDEMPTION_VOIDED"
  | "APPEAL_FILED"
  | "APPEAL_RESOLVED"
  | "CLEARING_BATCH_OPENED"
  | "CLAIM_SETTLED"
  | "ENTRY_REVERSED"
  | "CLEARING_BATCH_CLOSED";

export type AggregateType =
  | "match_session"
  | "match_ticket"
  | "benefit_policy"
  | "benefit_account"
  | "scenic_spot"
  | "terminal_device"
  | "redemption_proof"
  | "benefit_appeal"
  | "clearing_batch"
  | "clearing_entry";

export type TicketMedia = "PAPER" | "ELECTRONIC" | "COMPLIMENTARY";
export type TicketStatus =
  | "CONFIRMED"
  | "NOMINATED"
  | "TRANSFERRED"
  | "REFUNDED"
  | "INVALIDATED";

/**
 * PER_SPOT：各景区额度分别计数——政策允许跨景区重复使用、同日多点游览。
 * GLOBAL：全部协议景区合计计数——跨景区去重。
 * 规则由政策版本决定，核销端不做一刀切去重。
 */
export type RedemptionScope = "PER_SPOT" | "GLOBAL";
export type Relationship = "HOLDER" | "FAMILY" | "GUEST";
export type RedemptionChannel = "ONLINE" | "OFFLINE_SYNC";

export interface MatchWindow {
  relative_to: "KICKOFF";
  start_offset_hours: number;
  end_offset_hours: number;
}

export interface SpotTerm {
  spot_id: string;
  agreed_price_cents: number;
  requires_nomination: boolean;
}

export interface PolicyRules {
  policy_code: string;
  policy_version: number;
  effective_from: string;
  effective_to: string | null;
  match_window: MatchWindow;
  redemption_scope: RedemptionScope;
  max_per_spot: number;
  max_total: number;
  companions_allowed: boolean;
  max_companions: number;
  spot_terms: SpotTerm[];
}

export type RejectReason =
  | "OUTSIDE_WINDOW"
  | "SPOT_CLOSED"
  | "SPOT_NOT_COVERED"
  | "QUOTA_USED"
  | "NOT_NOMINATED"
  | "RELATIONSHIP_DENIED"
  | "DEVICE_SPOT_MISMATCH"
  | "TICKET_REFUNDED"
  | "TICKET_INVALIDATED"
  | "EXPIRED_POLICY"
  | "DEVICE_UNKNOWN"
  | "OFFLINE_QUOTA_EXCEEDED"
  | "SIGNATURE_INVALID";

export type VoidReason =
  | "DOUBLE_SPEND"
  | "SIGNATURE_INVALID"
  | "STALE_DEVICE"
  | "QUOTA_CONFLICT";
