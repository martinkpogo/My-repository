import test from "node:test";
import assert from "node:assert";
import { canRead, canWrite, getDataSource, resolveDataSourceEnvId, DATA_SOURCE_REGISTRY } from "./dataSourceRegistry";
import type { Env } from "../types";

/**
 * Covers the Data Source Registry's eligibility rules (ENIG Operating
 * Model design doc, "Platform layer") -- the declared facts about who
 * may read/write each source, grounded in what the codebase's own
 * existing behavior already does.
 */

test("getDataSource: an unregistered id fails closed with a clear error", () => {
  assert.throws(() => getDataSource("nonexistent" as any), /not a registered data source/);
});

test("canRead: matters is readable by Sales/Strategy/Finance, not by Marketing", () => {
  assert.strictEqual(canRead("matters", "Sales"), true);
  assert.strictEqual(canRead("matters", "Strategy"), true);
  assert.strictEqual(canRead("matters", "Finance"), true);
  assert.strictEqual(canRead("matters", "Marketing"), false);
});

test("canRead: handoffs and activity are readable by every Unit ('all')", () => {
  for (const unit of ["Sales", "Marketing", "Business Development", "Finance", "Strategy", "Research & Intelligence", "Creative & Design", "Operations"] as const) {
    assert.strictEqual(canRead("handoffs", unit), true, `handoffs should be readable by ${unit}`);
    assert.strictEqual(canRead("activity", unit), true, `activity should be readable by ${unit}`);
  }
});

test("canRead: leads is readable only by Sales", () => {
  assert.strictEqual(canRead("leads", "Sales"), true);
  assert.strictEqual(canRead("leads", "Business Development"), false);
});

test("canWrite: entities is writable only by Sales (Lead->Prospect->Client lifecycle)", () => {
  assert.strictEqual(canWrite("entities", "Sales"), true);
  assert.strictEqual(canWrite("entities", "Strategy"), false);
  assert.strictEqual(canWrite("entities", "Finance"), false);
});

test("canWrite: a source with no writableBy declared (leads, activity) is never writable through this registry", () => {
  assert.strictEqual(canWrite("leads", "Sales"), false);
  assert.strictEqual(canWrite("activity", "Sales"), false);
});

test("resolveDataSourceEnvId: returns the configured env value", () => {
  const env = { MATTERS_DATA_SOURCE_ID: "matters-ds-123" } as unknown as Env;
  assert.strictEqual(resolveDataSourceEnvId(env, "matters"), "matters-ds-123");
});

test("resolveDataSourceEnvId: fails closed when the env var isn't configured", () => {
  const env = {} as Env;
  assert.throws(() => resolveDataSourceEnvId(env, "matters"), /MATTERS_DATA_SOURCE_ID is not configured/);
});

test("Every registered data source declares a non-empty description (documentation completeness, not just a mechanical check)", () => {
  for (const id of Object.keys(DATA_SOURCE_REGISTRY) as (keyof typeof DATA_SOURCE_REGISTRY)[]) {
    assert.ok(DATA_SOURCE_REGISTRY[id].description.trim().length > 0, `${id} must have a description`);
  }
});
