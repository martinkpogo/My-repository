/// <reference types="node" />
import assert from "node:assert/strict";
import { test } from "node:test";
import { uniqueId } from "./notion";

test("uniqueId reads a bare auto_increment_id number", () => {
  assert.equal(uniqueId({ unique_id: { prefix: null, number: 47 } }), "47");
});

test("uniqueId prefixes the number when a prefix is configured", () => {
  assert.equal(uniqueId({ unique_id: { prefix: "E", number: 47 } }), "E-47");
});

test("uniqueId returns empty string for a missing property", () => {
  assert.equal(uniqueId(undefined), "");
  assert.equal(uniqueId(null), "");
  assert.equal(uniqueId({}), "");
});

test("uniqueId returns empty string when number is null or undefined", () => {
  assert.equal(uniqueId({ unique_id: { prefix: null, number: null } }), "");
  assert.equal(uniqueId({ unique_id: {} }), "");
});

test("uniqueId treats 0 as a valid number, not empty", () => {
  assert.equal(uniqueId({ unique_id: { prefix: null, number: 0 } }), "0");
});
