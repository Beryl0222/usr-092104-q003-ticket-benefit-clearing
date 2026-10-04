import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { validateEvent, eventTypes, aggregateTypes } from "../src/validator.js";

const schemaUrl = new URL("../contracts/domain.schema.json", import.meta.url);
const sampleUrl = new URL("../data/sample.json", import.meta.url);

test("既有样例仍符合信封约定（向后兼容）", async () => {
  const sample = JSON.parse(await readFile(sampleUrl, "utf8"));
  assert.deepEqual(validateEvent(sample), []);
});

test("校验器枚举与 JSON Schema 保持一致", async () => {
  const schema = JSON.parse(await readFile(schemaUrl, "utf8"));
  assert.deepEqual([...eventTypes].sort(), [...schema.properties.event_type.enum].sort());
  assert.deepEqual([...aggregateTypes].sort(), [...schema.properties.aggregate_type.enum].sort());
});

test("事件类型与聚合类型必须匹配，非法版本/时间被拒", () => {
  assert.deepEqual(validateEvent({
    event_id: "e1", event_type: "CLAIM_SETTLED", aggregate_type: "match_ticket",
    aggregate_id: "a", occurred_at: "2026-10-01T00:00:00Z", version: 1, summary: "x",
  }).some((m) => m.includes("聚合必须是")), true);

  assert.deepEqual(validateEvent({
    event_id: "e2", event_type: "UNKNOWN", aggregate_type: "match_ticket",
    aggregate_id: "a", occurred_at: "2026-10-01T00:00:00Z", version: 1, summary: "x",
  }).some((m) => m.includes("未知 event_type")), true);

  assert.deepEqual(validateEvent({
    event_id: "e3", event_type: "TICKET_CONFIRMED", aggregate_type: "match_ticket",
    aggregate_id: "a", occurred_at: "not-a-date", version: 0, summary: "x",
  }).length >= 2, true);
});

test("一条离线合并与清算事件能通过信封校验", () => {
  assert.deepEqual(validateEvent({
    event_id: "e4", event_type: "REDEMPTION_CAPTURED", aggregate_type: "redemption_proof",
    aggregate_id: "p1", occurred_at: "2026-10-12T02:00:00Z", version: 2,
    summary: "离线核销合并",
    payload: { channel: "OFFLINE_SYNC", policy_id: "pol_P_v1" },
    causation_id: "p1", correlation_id: "sync-1",
  }), []);
});
