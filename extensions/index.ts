/**
 * Web Research Extension
 *
 * Three tools:
 *
 * 1. `fetch_url` — Fetch a URL, extract readable content via Readability,
 *    return clean Markdown. Supports CSS selectors.
 *
 * 2. `web_search` — Search the web using a pluggable search provider
 *    (Brave, or any custom provider). Returns results directly.
 *
 * 3. `web_research` — Spawn a scout subagent (Haiku, cheap/fast) that
 *    uses fetch_url + web_search to research a topic, then returns only
 *    the relevant findings. Noise stays in the scout's context.
 *
 * Search providers are pluggable:
 *   - Built-in: Brave Search (auto-detected via BRAVE_API_KEY)
 *   - Built-in: fetch-only fallback (always available)
 *   - Custom: register via event bus or drop files in search-providers/
 *
 * Register a custom provider from another extension:
 *
 *   pi.events.emit("web-research:register-provider", {
 *     name: "my-engine",
 *     description: "My search engine",
 *     isAvailable: () => true,
 *     search: async (query, opts) => [{ title, url, snippet }],
 *   });
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import { StringEnum } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  truncateHead,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  SearchProviderRegistry,
  discoverFileProviders,
  type SearchProvider,
  type SearchResult,
} from "./search-providers.js";

// ─── Scout model resolution ────────────────────────────────────────

/**
 * Map of provider → small/cheap model suitable for scout tasks.
 * These are fast, inexpensive models good enough for fetch + summarize.
 * Users can override via the `model` parameter on web_research.
 */
const SCOUT_MODELS: Record<string, string> = {
  anthropic: "claude-haiku-4-5",
  openai: "gpt-4.1-mini",
  google: "gemini-2.0-flash",
  groq: "llama-3.3-70b-versatile",
  cerebras: "llama-3.3-70b",
  xai: "grok-3-mini-fast",
  mistral: "mistral-small-latest",
  openrouter: "anthropic/claude-haiku-4-5",
};

/** Default fallback if we can't determine the provider */
const DEFAULT_SCOUT_MODEL = "claude-haiku-4-5";

/**
 * Resolve the scout model based on the current session's provider.
 * Priority:
 *   1. Explicit `model` parameter from the user
 *   2. Small model matching the current provider
 *   3. Default fallback (claude-haiku-4-5)
 */
function resolveScoutModel(
  explicitModel: string | undefined,
  currentProvider: string | undefined,
): string {
  if (explicitModel) return explicitModel;
  if (currentProvider && SCOUT_MODELS[currentProvider]) {
    return SCOUT_MODELS[currentProvider];
  }
  return DEFAULT_SCOUT_MODEL;
}

// ─── Fetch internals ───────────────────────────────────────────────

async function fetchAndExtract(
  url: string,
  opts: { selector?: string; maxLength?: number; includeLinks?: boolean },
): Promise<{ title: string; content: string; byline: string; length: number; url: string }> {
  const { Readability } = await import("@mozilla/readability");
  const { JSDOM } = await import("jsdom");
  const TurndownService = (await import("turndown")).default;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") || "";

  if (!contentType.includes("html")) {
    const raw = await response.text();
    const maxLen = opts.maxLength ?? 15_000;
    return { title: url, content: raw.slice(0, maxLen), byline: "", length: raw.length, url };
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });

  if (opts.selector) {
    const selected = dom.window.document.querySelector(opts.selector);
    if (selected) {
      dom.window.document.body.innerHTML = selected.outerHTML;
    }
  }

  const article = new Readability(dom.window.document).parse();
  if (!article || !article.content) {
    throw new Error("Readability could not extract content from this page");
  }

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  td.addRule("removeImages", { filter: "img", replacement: () => "" });

  if (!opts.includeLinks) {
    td.addRule("stripLinks", {
      filter: "a",
      replacement: (_content: string, node: any) => node.textContent || "",
    });
  }

  let markdown = td.turndown(article.content);

  markdown = markdown
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#+\s*$/gm, "")
    .replace(/^(Share|Tweet|Pin|Email|Print)(\s+(this|on|via))?.{0,20}$/gim, "")
    .replace(/^.*(cookie|consent|privacy policy|accept all).*$/gim, "")
    .trim();

  const maxLen = opts.maxLength ?? 15_000;
  if (markdown.length > maxLen) {
    markdown = markdown.slice(0, maxLen) + "\n\n[... truncated]";
  }

  return {
    title: article.title || "",
    content: markdown,
    byline: article.byline || "",
    length: article.length || markdown.length,
    url,
  };
}

// ─── Subagent runner ───────────────────────────────────────────────

interface ResearchResult {
  exitCode: number;
  output: string;
  usage: { input: number; output: number; cost: number; turns: number; model?: string };
  stderr: string;
}

async function runResearchAgent(
  cwd: string,
  task: string,
  systemPrompt: string,
  model: string,
  extensionDir: string,
  signal?: AbortSignal,
  onUpdate?: (text: string) => void,
): Promise<ResearchResult> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-"));
  const promptPath = path.join(tmpDir, "research-prompt.md");
  fs.writeFileSync(promptPath, systemPrompt, { encoding: "utf-8", mode: 0o600 });

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--model", model,
    "--tools", "read,bash",
    "-e", extensionDir,
    "--append-system-prompt", promptPath,
    `Task: ${task}`,
  ];

  const result: ResearchResult = {
    exitCode: 0,
    output: "",
    usage: { input: 0, output: 0, cost: 0, turns: 0 },
    stderr: "",
  };

  try {
    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env }, // pass through env (BRAVE_API_KEY, etc.)
      });

      let buffer = "";

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "message_end" && event.message?.role === "assistant") {
              const msg = event.message as Message;
              result.usage.turns++;
              if (msg.usage) {
                result.usage.input += msg.usage.input || 0;
                result.usage.output += msg.usage.output || 0;
                result.usage.cost += msg.usage.cost?.total || 0;
              }
              if (msg.model) result.usage.model = msg.model;

              for (const part of msg.content) {
                if (part.type === "text") {
                  result.output = part.text;
                  onUpdate?.(part.text);
                }
              }
            }
          } catch {
            // skip
          }
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        result.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.type === "message_end" && event.message?.role === "assistant") {
              for (const part of event.message.content) {
                if (part.type === "text") result.output = part.text;
              }
            }
          } catch { /* ignore */ }
        }
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    result.exitCode = exitCode;
  } finally {
    try { fs.unlinkSync(promptPath); } catch { /* ignore */ }
    try { fs.rmdirSync(tmpDir); } catch { /* ignore */ }
  }

  return result;
}

// ─── Extension entry point ─────────────────────────────────────────

export default function (pi: ExtensionAPI) {
  const registry = new SearchProviderRegistry();

  // Resolve the extension directory for passing to subagents
  const extensionDir = path.dirname(new URL(import.meta.url).pathname);

  // Track current provider for scout model resolution
  let currentProvider: string | undefined;

  pi.on("model_select", async (event) => {
    currentProvider = event.model.provider;
  });

  // ── Listen for provider registrations from other extensions ────

  pi.events.on("web-research:register-provider", (provider: SearchProvider) => {
    if (provider?.name && provider?.search && provider?.isAvailable) {
      registry.register(provider);
    }
  });

  // ── Discover file-based providers on startup ──────────────────

  pi.on("session_start", async (_event, ctx) => {
    try {
      const fileProviders = await discoverFileProviders(ctx.cwd);
      for (const provider of fileProviders) {
        registry.register(provider);
      }
    } catch {
      // Non-fatal — just skip file discovery
    }

    // Log available providers
    const available = registry.getAvailable();
    const searchProviders = available.filter((p) => p.name !== "fetch-only");
    if (searchProviders.length > 0) {
      const names = searchProviders.map((p) => p.name).join(", ");
      ctx.ui.setStatus("web-research", `search: ${names}`);
      // Clear after 3 seconds
      setTimeout(() => ctx.ui.setStatus("web-research", undefined), 3000);
    }
  });

  // ── Tool 1: fetch_url ──────────────────────────────────────────

  pi.registerTool({
    name: "fetch_url",
    label: "Fetch URL",
    description: [
      "Fetch a URL and return clean, readable content as Markdown.",
      "Uses Mozilla Readability to strip navigation, ads, and boilerplate.",
      "Use `selector` to extract a specific section (CSS selector).",
      "Use `maxLength` to limit output size (default: 15000 chars).",
      "Set `includeLinks: true` to preserve hyperlinks (stripped by default to save tokens).",
    ].join(" "),
    parameters: Type.Object({
      url: Type.String({ description: "URL to fetch" }),
      selector: Type.Optional(
        Type.String({ description: "CSS selector to narrow extraction (e.g. 'main', '.docs-content', '#api-reference')" }),
      ),
      maxLength: Type.Optional(
        Type.Number({ description: "Max characters to return. Default: 15000" }),
      ),
      includeLinks: Type.Optional(
        Type.Boolean({ description: "Keep hyperlinks in output. Default: false (saves tokens)" }),
      ),
    }),

    async execute(_toolCallId, params, _signal) {
      try {
        const result = await fetchAndExtract(params.url, {
          selector: params.selector,
          maxLength: params.maxLength,
          includeLinks: params.includeLinks,
        });

        const header = [
          result.title && `# ${result.title}`,
          result.byline && `*${result.byline}*`,
          `Source: ${result.url}`,
          `Extracted: ${result.content.length} chars from ${result.length} original`,
        ]
          .filter(Boolean)
          .join("\n");

        const text = `${header}\n\n---\n\n${result.content}`;

        const truncation = truncateHead(text, {
          maxLines: DEFAULT_MAX_LINES,
          maxBytes: DEFAULT_MAX_BYTES,
        });

        let output = truncation.content;
        if (truncation.truncated) {
          output += `\n\n[Truncated: ${truncation.outputLines}/${truncation.totalLines} lines, ${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}]`;
        }

        return {
          content: [{ type: "text" as const, text: output }],
          details: {
            url: result.url,
            title: result.title,
            extractedLength: result.content.length,
            originalLength: result.length,
            selector: params.selector,
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Failed to fetch ${params.url}: ${err.message}` }],
          details: { url: params.url, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("fetch_url "));
      text += theme.fg("accent", args.url || "...");
      if (args.selector) text += theme.fg("muted", ` → ${args.selector}`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      if (details?.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      let text = theme.fg("success", "✓ ");
      if (details?.title) text += theme.fg("toolTitle", details.title) + " ";
      text += theme.fg("muted", `(${details?.extractedLength ?? "?"} chars`);
      if (details?.selector) text += theme.fg("muted", `, selector: ${details.selector}`);
      text += theme.fg("muted", ")");

      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          text += "\n\n" + theme.fg("toolOutput", content.text.slice(0, 2000));
          if (content.text.length > 2000) text += theme.fg("muted", "\n... (truncated in preview)");
        }
      }

      return new Text(text, 0, 0);
    },
  });

  // ── Tool 2: web_search ─────────────────────────────────────────

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: [
      "Search the web using a pluggable search provider.",
      "Returns a list of results (title, url, snippet).",
      "Use `provider` to pick a specific search engine, or omit for the best available.",
      "Use this when you need to find URLs — then use fetch_url to read specific pages.",
    ].join(" "),
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      provider: Type.Optional(
        Type.String({ description: "Search provider name. Omit to use the best available." }),
      ),
      count: Type.Optional(
        Type.Number({ description: "Number of results. Default: 5, max: 20" }),
      ),
      freshness: Type.Optional(
        Type.String({ description: 'Freshness filter: "pd" (day), "pw" (week), "pm" (month), "py" (year)' }),
      ),
      country: Type.Optional(
        Type.String({ description: "Two-letter country code for localized results" }),
      ),
    }),

    async execute(_toolCallId, params, _signal) {
      // Resolve provider
      let provider: SearchProvider | undefined;
      if (params.provider) {
        provider = registry.get(params.provider);
        if (!provider) {
          const available = registry.getAvailable().map((p) => p.name).join(", ");
          return {
            content: [{ type: "text" as const, text: `Unknown provider "${params.provider}". Available: ${available}` }],
            details: { error: "unknown_provider", available },
            isError: true,
          };
        }
        if (!provider.isAvailable()) {
          return {
            content: [{ type: "text" as const, text: `Provider "${params.provider}" is not available. Check its configuration (API key, etc.).` }],
            details: { error: "provider_unavailable", provider: params.provider },
            isError: true,
          };
        }
      } else {
        provider = registry.getDefault();
        if (provider.name === "fetch-only") {
          const all = registry.getAll().filter((p) => p.name !== "fetch-only").map((p) => `${p.name} (${p.isAvailable() ? "✓" : "needs config"})`);
          return {
            content: [{
              type: "text" as const,
              text: [
                "No search provider available. web_search requires a search engine.",
                "Use fetch_url instead if you already have URLs.",
                "",
                "To enable search, set up one of:",
                all.length > 0 ? all.map((p) => `  - ${p}`).join("\n") : "  - Set BRAVE_API_KEY for Brave Search",
                "",
                "Or register a custom provider from another extension:",
                '  pi.events.emit("web-research:register-provider", { name, description, isAvailable, search })',
              ].join("\n"),
            }],
            details: { error: "no_search_provider" },
            isError: true,
          };
        }
      }

      try {
        const results = await provider.search(params.query, {
          count: params.count,
          freshness: params.freshness,
          country: params.country,
        });

        if (results.length === 0) {
          return {
            content: [{ type: "text" as const, text: `No results found for "${params.query}"` }],
            details: { provider: provider.name, query: params.query, count: 0 },
          };
        }

        const formatted = results
          .map((r, i) => {
            let entry = `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.snippet}`;
            if (r.content) entry += `\n   Content: ${r.content.slice(0, 200)}...`;
            return entry;
          })
          .join("\n\n");

        const text = `Search: "${params.query}" via ${provider.name} (${results.length} results)\n\n${formatted}`;

        return {
          content: [{ type: "text" as const, text }],
          details: {
            provider: provider.name,
            query: params.query,
            count: results.length,
            urls: results.map((r) => r.url),
          },
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Search failed (${provider.name}): ${err.message}` }],
          details: { provider: provider.name, error: err.message },
          isError: true,
        };
      }
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_search "));
      text += theme.fg("accent", `"${args.query || "..."}"`);
      if (args.provider) text += theme.fg("muted", ` via ${args.provider}`);
      if (args.count) text += theme.fg("dim", ` (${args.count} results)`);
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as any;
      if (details?.error) {
        return new Text(theme.fg("error", `✗ ${details.error}`), 0, 0);
      }

      let text = theme.fg("success", "✓ ");
      text += theme.fg("muted", `${details?.count ?? "?"} results via ${details?.provider ?? "?"}`);

      if (expanded) {
        const content = result.content[0];
        if (content?.type === "text") {
          text += "\n\n" + theme.fg("toolOutput", content.text);
        }
      } else if (details?.urls?.length) {
        const preview = details.urls.slice(0, 3).join("\n  ");
        text += "\n  " + theme.fg("dim", preview);
        if (details.urls.length > 3) text += theme.fg("muted", `\n  ... +${details.urls.length - 3} more`);
      }

      return new Text(text, 0, 0);
    },
  });

  // ── Tool 3: web_research ───────────────────────────────────────

  pi.registerTool({
    name: "web_research",
    label: "Web Research",
    description: [
      "Research a topic using a scout subagent with an isolated context window.",
      "The scout can search the web (if a search provider is available) and/or fetch specific URLs,",
      "then returns ONLY the information relevant to your task.",
      "Noise never enters your context — it stays in the scout's disposable context.",
      "",
      "Two modes:",
      "  - With URLs: scout fetches and analyzes the given pages",
      "  - With a query (no URLs): scout searches the web first, then reads relevant results",
      "  - Both: scout searches AND reads the given URLs",
    ].join("\n"),
    parameters: Type.Object({
      task: Type.String({
        description: "What you need to know. Be specific — the scout uses this to decide what's relevant.",
      }),
      urls: Type.Optional(
        Type.Array(Type.String(), { description: "Specific URLs to research. Optional." }),
      ),
      query: Type.Optional(
        Type.String({ description: "Search query. Optional. If provided, scout searches the web first." }),
      ),
      provider: Type.Optional(
        Type.String({ description: "Search provider for web search. Omit for best available." }),
      ),
      model: Type.Optional(
        Type.String({ description: "Model for the scout. Default: auto-detected small model matching your current provider." }),
      ),
    }),

    async execute(_toolCallId, params, signal, onUpdate) {
      const model = resolveScoutModel(params.model, currentProvider);
      const hasUrls = params.urls && params.urls.length > 0;
      const hasQuery = Boolean(params.query);

      if (!hasUrls && !hasQuery) {
        return {
          content: [{ type: "text" as const, text: "Provide at least `urls` or `query` (or both)." }],
          isError: true,
        };
      }

      // Figure out which search provider to mention in the scout's prompt
      let searchProviderName: string | undefined;
      let searchAvailable = false;

      if (hasQuery) {
        if (params.provider) {
          const p = registry.get(params.provider);
          if (p?.isAvailable()) {
            searchProviderName = p.name;
            searchAvailable = true;
          }
        } else {
          const defaultProvider = registry.getDefault();
          if (defaultProvider.name !== "fetch-only") {
            searchProviderName = defaultProvider.name;
            searchAvailable = true;
          }
        }

        if (!searchAvailable) {
          return {
            content: [{
              type: "text" as const,
              text: `No search provider available for query "${params.query}". Either provide explicit URLs, or configure a search provider (e.g., set BRAVE_API_KEY).`,
            }],
            details: { error: "no_search_provider" },
            isError: true,
          };
        }
      }

      // Build the scout's instructions
      const tools = ["fetch_url"];
      if (searchAvailable) tools.push("web_search");

      const toolList = tools.join(", ");

      let systemPrompt = `You are a web research specialist. You have these tools: ${toolList}.

Your workflow:`;

      if (hasQuery && searchAvailable) {
        systemPrompt += `
1. Use web_search to search for: the query given in the task${searchProviderName ? ` (provider: ${searchProviderName})` : ""}
2. Pick the most relevant results (usually 2-4)
3. Use fetch_url to read the full content of those pages`;
      }

      if (hasUrls) {
        const step = hasQuery ? "4" : "1";
        systemPrompt += `
${step}. Use fetch_url to retrieve content from each URL provided in the task`;
      }

      systemPrompt += `

Then:
- Analyze all the content you've gathered
- Return ONLY the information relevant to the research task
- Discard everything else (navigation, ads, boilerplate, tangential info)

Output rules:
- Be concise — the caller has limited context
- Use bullet points and headers for scannability
- Include specific code examples, API signatures, or config when relevant
- Quote exact values (version numbers, URLs, commands) — don't paraphrase technical details
- If content is too long, prioritize the most relevant sections`;

      // Build the task prompt
      let taskText = `Research task: ${params.task}`;
      if (hasUrls) {
        const urlList = params.urls!.map((u, i) => `  ${i + 1}. ${u}`).join("\n");
        taskText += `\n\nURLs to read:\n${urlList}`;
      }
      if (hasQuery) {
        taskText += `\n\nSearch query: ${params.query}`;
      }

      const totalItems = (params.urls?.length ?? 0) + (hasQuery ? 1 : 0);
      onUpdate?.({
        content: [{ type: "text", text: `Researching ${hasQuery ? `"${params.query}"` : ""} ${hasUrls ? `+ ${params.urls!.length} URL(s)` : ""} with ${model}...` }],
      });

      const result = await runResearchAgent(
        process.cwd(),
        taskText,
        systemPrompt,
        model,
        extensionDir,
        signal,
        (text) => {
          onUpdate?.({
            content: [{ type: "text", text }],
            details: { status: "running", model },
          });
        },
      );

      if (result.exitCode !== 0) {
        return {
          content: [{ type: "text" as const, text: `Research failed: ${result.stderr || result.output || "(no output)"}` }],
          details: { model, status: "error", exitCode: result.exitCode },
          isError: true,
        };
      }

      const usageLine = [
        `${result.usage.turns} turns`,
        `↑${result.usage.input} ↓${result.usage.output}`,
        `$${result.usage.cost.toFixed(4)}`,
        result.usage.model ?? model,
      ].join(" | ");

      return {
        content: [{ type: "text" as const, text: result.output || "(no output)" }],
        details: {
          urls: params.urls,
          query: params.query,
          provider: searchProviderName,
          model: result.usage.model ?? model,
          status: "done",
          usage: result.usage,
          usageSummary: usageLine,
        },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("web_research "));
      if (args.query) text += theme.fg("accent", `"${args.query}"`);
      if (args.urls?.length) {
        if (args.query) text += " + ";
        text += theme.fg("accent", `${args.urls.length} URL(s)`);
      }
      if (args.provider) text += theme.fg("muted", ` via ${args.provider}`);
      const taskPreview = (args.task ?? "").slice(0, 60);
      text += "\n  " + theme.fg("dim", taskPreview + ((args.task?.length ?? 0) > 60 ? "..." : ""));
      return new Text(text, 0, 0);
    },

    renderResult(result, { expanded }, theme) {
      const details = result.details as any;

      if (details?.status === "error") {
        return new Text(theme.fg("error", `✗ Research failed (exit ${details.exitCode})`), 0, 0);
      }

      if (details?.status === "running") {
        const content = result.content[0];
        const preview = content?.type === "text" ? content.text.slice(0, 200) : "...";
        return new Text(theme.fg("warning", "⏳ ") + theme.fg("dim", preview), 0, 0);
      }

      const mdTheme = getMarkdownTheme();

      if (expanded) {
        const container = new Container();
        let header = theme.fg("success", "✓ ") + theme.fg("toolTitle", theme.bold("Research complete"));
        if (details?.provider) header += theme.fg("muted", ` via ${details.provider}`);
        container.addChild(new Text(header, 0, 0));

        const content = result.content[0];
        if (content?.type === "text" && content.text) {
          container.addChild(new Spacer(1));
          container.addChild(new Markdown(content.text, 0, 0, mdTheme));
        }

        if (details?.usageSummary) {
          container.addChild(new Spacer(1));
          container.addChild(new Text(theme.fg("dim", details.usageSummary), 0, 0));
        }

        return container;
      }

      // Collapsed
      let text = theme.fg("success", "✓ ") + theme.fg("toolTitle", "Research complete");
      if (details?.provider) text += theme.fg("muted", ` via ${details.provider}`);

      const content = result.content[0];
      if (content?.type === "text") {
        const preview = content.text.split("\n").slice(0, 5).join("\n");
        text += "\n" + theme.fg("toolOutput", preview);
        if (content.text.split("\n").length > 5) text += "\n" + theme.fg("muted", "(Ctrl+O to expand)");
      }

      if (details?.usageSummary) {
        text += "\n" + theme.fg("dim", details.usageSummary);
      }

      return new Text(text, 0, 0);
    },
  });

  // ── Command: /search-providers ─────────────────────────────────

  pi.registerCommand("search-providers", {
    description: "List available web search providers",
    handler: async (_args, ctx) => {
      const all = registry.getAll();
      const lines = all.map((p) => {
        const status = p.isAvailable() ? "✓" : "✗";
        const isDefault = registry.getDefault().name === p.name ? " (default)" : "";
        return `  ${status} ${p.name}${isDefault} — ${p.description}`;
      });

      ctx.ui.notify(
        `Search providers:\n${lines.join("\n")}\n\nRegister custom providers via event bus or search-providers/ directory.`,
        "info",
      );
    },
  });
}
