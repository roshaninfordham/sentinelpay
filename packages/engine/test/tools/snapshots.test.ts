import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openApiDocument } from "../../src/http";
import { toAnthropicTools, toOpenAITools, toolDefinitions } from "../../src/tools";

// Drift guard (§7.2): the first run writes test/__snapshots__/<name>.json; later runs must match byte for byte.
// Regenerate deliberately with UPDATE_SNAPSHOTS=1.

const SNAPSHOT_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "__snapshots__");

function matchSnapshot(name: string, value: unknown) {
  const file = join(SNAPSHOT_DIR, `${name}.json`);
  const actual = `${JSON.stringify(value, null, 2)}\n`;
  if (!existsSync(file) || process.env.UPDATE_SNAPSHOTS === "1") {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  assert.equal(actual, readFileSync(file, "utf8"), `${name} drifted from test/__snapshots__/${name}.json (UPDATE_SNAPSHOTS=1 to accept)`);
}

test("snapshot: toolDefinitions", () => matchSnapshot("tool-definitions", toolDefinitions));
test("snapshot: toOpenAITools()", () => matchSnapshot("openai-tools", toOpenAITools()));
test("snapshot: toAnthropicTools()", () => matchSnapshot("anthropic-tools", toAnthropicTools()));
test("snapshot: openapi.json", () => matchSnapshot("openapi", openApiDocument()));
