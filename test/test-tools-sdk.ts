/**
 * SDK integration test — verifies the extension loads correctly
 * and both tools (fetch_url, web_research) are registered and callable
 * through pi's SDK.
 *
 * Run: npx tsx test/test-tools-sdk.ts
 *
 * Requires ANTHROPIC_API_KEY to be set (uses the LLM to call tools).
 */

import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";

// ─── Helpers ───────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (condition) {
    console.log(`  ✓ ${message}`);
    passed++;
  } else {
    console.error(`  ✗ ${message}`);
    failed++;
  }
}

function section(name: string) {
  console.log(`\n── ${name} ──`);
}

// ─── Setup ─────────────────────────────────────────────────────────

const extensionPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

async function createTestSession() {
  const authStorage = AuthStorage.create();
  const modelRegistry = new ModelRegistry(authStorage);

  // Use a temp agentDir so we don't conflict with globally-installed copy
  const tmpAgentDir = path.join(os.tmpdir(), `pi-web-research-test-${Date.now()}`);
  fs.mkdirSync(tmpAgentDir, { recursive: true });

  const loader = new DefaultResourceLoader({
    additionalExtensionPaths: [extensionPath],
    agentDir: tmpAgentDir,
    // Disable discovery so we only get our extension
    systemPromptOverride: () =>
      "You are a test assistant. When asked to use a tool, use it exactly as instructed. Be minimal in your responses.",
  });
  await loader.reload();

  const { session, extensionsResult } = await createAgentSession({
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    authStorage,
    modelRegistry,
  });

  return { session, extensionsResult };
}

// ─── Tests ─────────────────────────────────────────────────────────

async function run() {
  section("Extension loading");
  {
    const { session, extensionsResult } = await createTestSession();

    assert(extensionsResult.errors.length === 0, "No extension loading errors");
    if (extensionsResult.errors.length > 0) {
      for (const err of extensionsResult.errors) {
        console.error(`    Error in ${err.path}: ${err.error}`);
      }
    }

    // Check that our tools are registered
    const toolNames = session.agent.state.tools.map((t) => t.name);
    assert(toolNames.includes("fetch_url"), "fetch_url tool is registered");
    assert(toolNames.includes("web_research"), "web_research tool is registered");

    console.log(`    Registered tools: ${toolNames.join(", ")}`);
    session.dispose();
  }

  section("fetch_url via LLM");
  {
    const { session } = await createTestSession();

    let toolCalled = false;
    let toolResult = "";

    session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "fetch_url") {
        toolCalled = true;
      }
      if (event.type === "tool_execution_end" && event.toolName === "fetch_url") {
        const content = event.result?.content;
        if (content && content.length > 0 && content[0].type === "text") {
          toolResult = content[0].text;
        }
      }
    });

    await session.prompt(
      'Use the fetch_url tool to fetch "https://httpbin.org/html" and tell me what the page title is. Be brief.',
    );

    assert(toolCalled, "LLM called fetch_url");
    assert(toolResult.length > 0, `fetch_url returned content (${toolResult.length} chars)`);

    session.dispose();
  }

  section("fetch_url with selector via LLM");
  {
    const { session } = await createTestSession();

    let fetchArgs: any = null;

    session.subscribe((event) => {
      if (event.type === "tool_execution_start" && event.toolName === "fetch_url") {
        fetchArgs = event.args;
      }
    });

    await session.prompt(
      'Use fetch_url to get "https://docs.python.org/3/library/json.html" with selector "main" and maxLength 3000. Summarize in one sentence.',
    );

    assert(fetchArgs !== null, "LLM called fetch_url");
    if (fetchArgs) {
      assert(fetchArgs.selector === "main", `Used selector: "${fetchArgs.selector}"`);
      assert(fetchArgs.maxLength === 3000, `Used maxLength: ${fetchArgs.maxLength}`);
    }

    session.dispose();
  }

  // ─── Summary ───────────────────────────────────────────────────

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
  else console.log("All tests passed ✓");
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
