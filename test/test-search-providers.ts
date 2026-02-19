/**
 * Unit tests for the search provider registry.
 *
 * Run: npx tsx test/test-search-providers.ts
 */

import { SearchProviderRegistry, type SearchProvider } from "../extensions/search-providers.js";

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

// ─── Tests ─────────────────────────────────────────────────────────

section("Built-in providers");
{
  const reg = new SearchProviderRegistry();
  const all = reg.getAll();

  assert(all.length >= 2, `Has at least 2 built-in providers (got ${all.length})`);
  assert(all.some((p) => p.name === "brave"), "Has brave provider");
  assert(all.some((p) => p.name === "fetch-only"), "Has fetch-only fallback");
}

section("fetch-only is always available");
{
  const reg = new SearchProviderRegistry();
  const fetchOnly = reg.get("fetch-only")!;

  assert(fetchOnly !== undefined, "fetch-only exists");
  assert(fetchOnly.isAvailable(), "fetch-only is always available");
}

section("Brave availability depends on API key");
{
  const reg = new SearchProviderRegistry();
  const brave = reg.get("brave")!;

  const hasBraveKey = Boolean(process.env.BRAVE_API_KEY);
  assert(brave.isAvailable() === hasBraveKey, `Brave available=${brave.isAvailable()} matches key=${hasBraveKey}`);
}

section("Default provider selection");
{
  const reg = new SearchProviderRegistry();
  const def = reg.getDefault();

  if (process.env.BRAVE_API_KEY) {
    assert(def.name === "brave", "Default is brave when BRAVE_API_KEY is set");
  } else {
    assert(def.name === "fetch-only", "Default is fetch-only when no search keys");
  }
}

section("Custom provider registration");
{
  const reg = new SearchProviderRegistry();

  const custom: SearchProvider = {
    name: "my-engine",
    description: "Test search engine",
    isAvailable: () => true,
    search: async (query) => [
      { title: "Test Result", url: "https://example.com", snippet: `Result for: ${query}` },
    ],
  };

  reg.register(custom);

  assert(reg.get("my-engine") !== undefined, "Custom provider registered");
  assert(reg.get("my-engine")!.isAvailable(), "Custom provider is available");

  // Now it should be the default (since it's a real search engine)
  const def = reg.getDefault();
  if (!process.env.BRAVE_API_KEY) {
    assert(def.name === "my-engine", "Custom provider becomes default when no other search available");
  } else {
    // Brave was registered first, so it stays default
    assert(def.name === "brave" || def.name === "my-engine", "Default is a real search provider");
  }
}

section("Custom provider search works");
{
  const reg = new SearchProviderRegistry();

  const custom: SearchProvider = {
    name: "mock",
    description: "Mock search",
    isAvailable: () => true,
    search: async (query, opts) => {
      const count = opts?.count ?? 3;
      return Array.from({ length: count }, (_, i) => ({
        title: `Result ${i + 1}`,
        url: `https://example.com/${i + 1}`,
        snippet: `Snippet for "${query}" result ${i + 1}`,
      }));
    },
  };

  reg.register(custom);

  const results = await custom.search("test query", { count: 2 });
  assert(results.length === 2, `Got ${results.length} results`);
  assert(results[0].title === "Result 1", "First result title correct");
  assert(results[0].snippet.includes("test query"), "Snippet includes query");
}

section("Provider unregistration");
{
  const reg = new SearchProviderRegistry();
  reg.register({
    name: "temp",
    description: "Temporary",
    isAvailable: () => true,
    search: async () => [],
  });

  assert(reg.get("temp") !== undefined, "Provider registered");
  reg.unregister("temp");
  assert(reg.get("temp") === undefined, "Provider unregistered");
}

section("Unavailable custom provider excluded from available list");
{
  const reg = new SearchProviderRegistry();

  reg.register({
    name: "broken",
    description: "Needs config",
    isAvailable: () => false,
    search: async () => [],
  });

  const available = reg.getAvailable();
  assert(!available.some((p) => p.name === "broken"), "Unavailable provider excluded from getAvailable()");

  const all = reg.getAll();
  assert(all.some((p) => p.name === "broken"), "Unavailable provider still in getAll()");
}

section("Provider override (re-register same name)");
{
  const reg = new SearchProviderRegistry();

  reg.register({
    name: "brave",
    description: "Custom Brave wrapper",
    isAvailable: () => true,
    search: async () => [{ title: "Custom", url: "https://custom.com", snippet: "Overridden" }],
  });

  const brave = reg.get("brave")!;
  assert(brave.description === "Custom Brave wrapper", "Provider overridden by name");
  assert(brave.isAvailable(), "Overridden provider is available");

  const results = await brave.search("test");
  assert(results[0].title === "Custom", "Overridden provider returns custom results");
}

// ─── Summary ───────────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log("All tests passed ✓");
