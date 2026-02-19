/**
 * Search Provider Registry
 *
 * Pluggable search backends for web_research. Each provider is a simple
 * interface: given a query, return search results (title, url, snippet).
 *
 * Built-in providers are auto-detected based on what's available:
 *   - brave-search: requires BRAVE_API_KEY env var
 *
 * Users register custom providers via the extension event bus:
 *
 *   pi.events.emit("web-research:register-provider", {
 *     name: "my-search",
 *     description: "My custom search engine",
 *     search: async (query, opts) => [{ title, url, snippet }],
 *   });
 *
 * Or by dropping a provider file in ~/.pi/agent/search-providers/ or
 * .pi/search-providers/ that exports a SearchProvider.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ─── Types ─────────────────────────────────────────────────────────

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /** Optional: pre-fetched page content as markdown */
  content?: string;
}

export interface SearchOptions {
  /** Max results to return. Default: 5 */
  count?: number;
  /** Freshness filter: "pd" (day), "pw" (week), "pm" (month), "py" (year) */
  freshness?: string;
  /** Country code for localized results */
  country?: string;
  /** Whether to include full page content */
  includeContent?: boolean;
}

export interface SearchProvider {
  /** Unique name (e.g., "brave", "google", "serper") */
  name: string;
  /** Human-readable description */
  description: string;
  /** Run a search query */
  search(query: string, options?: SearchOptions): Promise<SearchResult[]>;
  /** Whether this provider is currently available (has API key, etc.) */
  isAvailable(): boolean;
}

// ─── Built-in: Brave Search ────────────────────────────────────────

function createBraveProvider(): SearchProvider {
  return {
    name: "brave",
    description: "Brave Search API — web search with optional content extraction",

    isAvailable() {
      return Boolean(process.env.BRAVE_API_KEY);
    },

    async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
      const apiKey = process.env.BRAVE_API_KEY;
      if (!apiKey) throw new Error("BRAVE_API_KEY not set");

      const count = options?.count ?? 5;
      const params = new URLSearchParams({
        q: query,
        count: String(Math.min(count, 20)),
      });
      if (options?.freshness) params.set("freshness", options.freshness);
      if (options?.country) params.set("country", options.country);

      const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
      });

      if (!response.ok) {
        throw new Error(`Brave Search API error: HTTP ${response.status} ${response.statusText}`);
      }

      const data = await response.json() as any;
      const results: SearchResult[] = [];

      for (const item of data.web?.results ?? []) {
        results.push({
          title: item.title || "",
          url: item.url || "",
          snippet: item.description || "",
        });
      }

      return results;
    },
  };
}

// ─── Built-in: fetch-only (no search, just fetches given URLs) ─────

function createFetchOnlyProvider(): SearchProvider {
  return {
    name: "fetch-only",
    description: "No search — only works with explicit URLs. Always available as fallback.",

    isAvailable() {
      return true; // always available
    },

    async search(_query: string, _options?: SearchOptions): Promise<SearchResult[]> {
      // This provider doesn't search — it's a marker that tells the
      // research agent to only use fetch_url on provided URLs.
      return [];
    },
  };
}

// ─── Registry ──────────────────────────────────────────────────────

export class SearchProviderRegistry {
  private providers = new Map<string, SearchProvider>();

  constructor() {
    // Register built-in providers
    this.register(createBraveProvider());
    this.register(createFetchOnlyProvider());
  }

  register(provider: SearchProvider) {
    this.providers.set(provider.name, provider);
  }

  unregister(name: string) {
    this.providers.delete(name);
  }

  get(name: string): SearchProvider | undefined {
    return this.providers.get(name);
  }

  /** Get all available providers (those with valid credentials/config) */
  getAvailable(): SearchProvider[] {
    return Array.from(this.providers.values()).filter((p) => p.isAvailable());
  }

  /** Get all registered providers regardless of availability */
  getAll(): SearchProvider[] {
    return Array.from(this.providers.values());
  }

  /** Get the best available search provider (first real search engine, or fetch-only fallback) */
  getDefault(): SearchProvider {
    // Prefer real search engines over fetch-only
    const available = this.getAvailable().filter((p) => p.name !== "fetch-only");
    if (available.length > 0) return available[0];
    return this.providers.get("fetch-only")!;
  }

  /** List providers as a string for tool descriptions */
  describe(): string {
    const available = this.getAvailable();
    if (available.length === 0) return "No search providers available.";

    return available
      .map((p) => {
        const status = p.name === "fetch-only" ? "(fallback)" : "✓";
        return `${status} ${p.name}: ${p.description}`;
      })
      .join("\n");
  }
}

// ─── File-based provider discovery ─────────────────────────────────

/**
 * Load custom search providers from ~/.pi/agent/search-providers/ and
 * .pi/search-providers/. Each file should export a SearchProvider or
 * a function that returns one.
 */
export async function discoverFileProviders(cwd: string): Promise<SearchProvider[]> {
  const providers: SearchProvider[] = [];
  const dirs = [
    path.join(os.homedir(), ".pi", "agent", "search-providers"),
    path.join(cwd, ".pi", "search-providers"),
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".js")) continue;

      try {
        const filePath = path.join(dir, entry.name);
        const mod = await import(filePath);
        const exported = mod.default ?? mod;

        if (typeof exported === "function") {
          const provider = exported();
          if (provider?.name && provider?.search) {
            providers.push(provider);
          }
        } else if (exported?.name && exported?.search) {
          providers.push(exported);
        }
      } catch {
        // Skip files that fail to load
      }
    }
  }

  return providers;
}
