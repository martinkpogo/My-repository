import test from "node:test";
import assert from "node:assert";
import { getConnector, isConnectorEligible, CONNECTOR_REGISTRY } from "./connectorRegistry";
import type { Env } from "../types";

test("getConnector: an unregistered id fails closed with a clear error", () => {
  assert.throws(() => getConnector("nonexistent" as any), /not a registered connector/);
});

test("isConnectorEligible: notion depends on NOTION_TOKEN being set", () => {
  assert.strictEqual(isConnectorEligible({ NOTION_TOKEN: "x" } as Env, "notion"), true);
  assert.strictEqual(isConnectorEligible({} as Env, "notion"), false);
});

test("isConnectorEligible: telegram depends on TELEGRAM_BOT_TOKEN being set", () => {
  assert.strictEqual(isConnectorEligible({ TELEGRAM_BOT_TOKEN: "x" } as Env, "telegram"), true);
  assert.strictEqual(isConnectorEligible({} as Env, "telegram"), false);
});

test("isConnectorEligible: web_search is optional -- absent TAVILY_API_KEY means unavailable, not an error", () => {
  assert.strictEqual(isConnectorEligible({} as Env, "web_search"), false);
  assert.strictEqual(isConnectorEligible({ TAVILY_API_KEY: "x" } as Env, "web_search"), true);
});

test("isConnectorEligible: google_workspace reflects whether OAuth is configured", () => {
  assert.strictEqual(isConnectorEligible({} as Env, "google_workspace"), false);
  assert.strictEqual(isConnectorEligible({ GOOGLE_OAUTH_CLIENT_ID: "x" } as Env, "google_workspace"), true);
});

test("Every registered connector declares a non-empty description", () => {
  for (const id of Object.keys(CONNECTOR_REGISTRY) as (keyof typeof CONNECTOR_REGISTRY)[]) {
    assert.ok(CONNECTOR_REGISTRY[id].description.trim().length > 0, `${id} must have a description`);
  }
});
