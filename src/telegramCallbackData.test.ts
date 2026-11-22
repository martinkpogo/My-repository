import test from "node:test";
import assert from "node:assert";
import { parseCallbackData } from "./telegramCallbackData";

test("three pieces: value is everything after the second colon", () => {
  assert.deepStrictEqual(parseCallbackData("googleaction:W1:approve"), {
    action: "googleaction",
    workId: "W1",
    value: "approve",
  });
});

test("four pieces: the 4th segment is kept in value (googlefolder position)", () => {
  assert.deepStrictEqual(parseCallbackData("googlefolder:W1:ab12cd34:7"), {
    action: "googlefolder",
    workId: "W1",
    value: "ab12cd34:7",
  });
});

test("'more' folder page button keeps its 4th segment", () => {
  assert.deepStrictEqual(parseCallbackData("googlefolder:W1:ab12cd34:more"), {
    action: "googlefolder",
    workId: "W1",
    value: "ab12cd34:more",
  });
});

test("empty middle: workId is empty, value keeps its own colon semantics", () => {
  assert.deepStrictEqual(parseCallbackData("mode::chat"), {
    action: "mode",
    workId: "",
    value: "chat",
  });
});

test("trailing colon: value is empty, never undefined", () => {
  assert.deepStrictEqual(parseCallbackData("switch:W1:"), {
    action: "switch",
    workId: "W1",
    value: "",
  });
});

test("no colon at all: action only, missing parts are empty strings", () => {
  assert.deepStrictEqual(parseCallbackData("garbage"), {
    action: "garbage",
    workId: "",
    value: "",
  });
});

test("empty string: all parts empty, never throws", () => {
  assert.deepStrictEqual(parseCallbackData(""), {
    action: "",
    workId: "",
    value: "",
  });
});
