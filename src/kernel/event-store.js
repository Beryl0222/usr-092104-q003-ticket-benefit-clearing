/**
 * 事件存储与事件目录（event sourcing 内核）。
 * - 事件只增不改；每个聚合内 version 单调递增（乐观并发）。
 * - event_id 全局幂等：重复投递不产生第二条事件。
 * - 订阅者按提交顺序收到事件，供后续投影/审计/外发使用。
 */
import { randomId } from "./ids.js";
import { validateEvent } from "../validator.js";

export class ConcurrencyError extends Error {
  constructor(aggregateId, expected, actual) {
    super(`聚合 ${aggregateId} 版本冲突：期望 ${expected}，实际 ${actual}`);
    this.code = "CONCURRENCY_ERROR";
  }
}

export class EventStore {
  #events = [];
  #subscribers = new Set();
  #clock;

  /**
   * @param {{clock?: () => Date}} [opts] 注入时钟：离线/演示/测试需让“未显式指定的事件发生时间”
   * 走业务时钟而非墙钟，否则时点重放会错乱（例如退票事件时间早于离线核销）。
   */
  constructor({ clock = () => new Date() } = {}) {
    this.#clock = clock;
  }

  /**
   * 提交一批事件（同一事务：全部成功或全部失败）。
   * @param {Array<{event_type:string, aggregate_type:string, aggregate_id:string, occurred_at?:string, summary:string, payload?:object, causation_id?:string, correlation_id?:string}>} drafts
   * @param {{expectedVersion?:number, correlationId?:string}} [opts] 同聚合 expectedVersion 为其当前最大版本
   */
  commit(drafts, opts = {}) {
    const now = new Date(this.#clock()).toISOString();
    const prepared = [];

    // 分组计算各聚合的目标版本（本批内同聚合多事件要连续编号）。
    const nextVersion = new Map();
    const groups = [];
    for (const draft of drafts) {
      const current = this.#aggregateVersion(draft.aggregate_id);
      const base = nextVersion.has(draft.aggregate_id)
        ? nextVersion.get(draft.aggregate_id)
        : current;
      const version = base + 1;
      nextVersion.set(draft.aggregate_id, version);
      groups.push({ draft, version, current });
    }

    for (const { draft, version, current } of groups) {
      if (opts.expectedVersion != null && current !== opts.expectedVersion) {
        throw new ConcurrencyError(draft.aggregate_id, opts.expectedVersion, current);
      }
      const event = {
        event_id: draft.event_id ?? randomId("evt"),
        event_type: draft.event_type,
        aggregate_type: draft.aggregate_type,
        aggregate_id: draft.aggregate_id,
        occurred_at: draft.occurred_at ?? now,
        version,
        summary: draft.summary,
        ...(draft.payload ? { payload: draft.payload } : {}),
        ...(draft.causation_id ? { causation_id: draft.causation_id } : {}),
        ...(opts.correlationId || draft.correlation_id
          ? { correlation_id: opts.correlationId ?? draft.correlation_id }
          : {}),
      };
      const errors = validateEvent(event);
      if (errors.length) throw new Error(`事件校验失败：${errors.join("；")}`);
      prepared.push(event);
    }

    // 批内与历史幂等：同一 event_id 只保留一次。
    const seenInBatch = new Set();
    for (const event of prepared) {
      if (seenInBatch.has(event.event_id)) {
        throw new Error(`批内重复 event_id：${event.event_id}`);
      }
      seenInBatch.add(event.event_id);
      if (this.#events.some((e) => e.event_id === event.event_id)) {
        throw new Error(`事件已存在（幂等冲突）：${event.event_id}`);
      }
    }

    this.#events.push(...prepared);
    for (const fn of this.#subscribers) {
      for (const event of prepared) fn(event);
    }
    return prepared;
  }

  #aggregateVersion(aggregateId) {
    let v = 0;
    for (const e of this.#events) {
      if (e.aggregate_id === aggregateId && e.version > v) v = e.version;
    }
    return v;
  }

  load(aggregateId) {
    return this.#events.filter((e) => e.aggregate_id === aggregateId).sort((a, b) => a.version - b.version);
  }

  /** 按事件发生时间排序（离线合并依赖业务发生时间而非提交顺序）。 */
  allByOccurredAt() {
    return [...this.#events].sort(
      (a, b) => new Date(a.occurred_at) - new Date(b.occurred_at) || a.event_id.localeCompare(b.event_id),
    );
  }

  allByCommit() {
    return [...this.#events];
  }

  findEvent(eventId) {
    return this.#events.find((e) => e.event_id === eventId) ?? null;
  }

  eventsByType(...types) {
    return this.#events.filter((e) => types.includes(e.event_type));
  }

  subscribe(fn) {
    this.#subscribers.add(fn);
    return () => this.#subscribers.delete(fn);
  }

  get size() {
    return this.#events.length;
  }
}
