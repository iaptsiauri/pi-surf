# 🏄 pi-surf

Surf the web from [pi](https://github.com/mariozechner/pi-coding-agent). Clean URL fetching, pluggable search, and a scout subagent that keeps noise out of your context.

## Install

```bash
pi install npm:pi-surf
```

Or try it without installing:

```bash
pi -e npm:pi-surf
```

## What You Get

Three tools:

### `fetch_url`

Fetch any URL and get clean Markdown. Uses Mozilla Readability (the same engine behind Firefox Reader View) to strip navigation, ads, and boilerplate, then converts to Markdown via Turndown.

```
Fetch https://docs.example.com/api and extract the main content
```

- CSS selector support (`selector: "main"`, `".docs-content"`, `"#api-reference"`)
- Links stripped by default (saves ~50 tokens per link) — set `includeLinks: true` to keep them
- Images stripped (not useful in LLM context)
- Configurable length limit (`maxLength`, default 15000 chars)

### `web_search`

Search the web using a pluggable backend. Returns titles, URLs, and snippets.

```
Search for "pulumi rds proxy typescript example"
```

Currently supported providers:
- **Brave Search** — auto-detected via `BRAVE_API_KEY` env var
- **Custom providers** — register your own (see below)

### `web_research`

The flagship tool. Spawns a lightweight scout subagent that:

1. Searches the web (if a search provider is configured)
2. Fetches and reads relevant pages
3. Analyzes the content
4. Returns **only** what's relevant to your task

All the noise (raw HTML, navigation, ads, irrelevant sections) stays in the scout's disposable context and never enters your main session.

```
Research how to configure RDS Proxy with PostgreSQL and Django,
focusing on connection pooling settings and session pinning
```

**Auto-detected scout model:** The scout automatically uses a small/cheap model matching your current provider:

| Your Provider | Scout Uses |
|--------------|------------|
| Anthropic | `claude-haiku-4-5` |
| OpenAI | `gpt-4.1-mini` |
| Google | `gemini-2.0-flash` |
| Groq | `llama-3.3-70b-versatile` |
| xAI | `grok-3-mini-fast` |
| Mistral | `mistral-small-latest` |
| OpenRouter | `anthropic/claude-haiku-4-5` |

Override per-call with the `model` parameter.

## Search Providers

### Brave Search (built-in)

Set the environment variable:

```bash
export BRAVE_API_KEY="your-key-here"
```

Get a key at [brave.com/search/api](https://brave.com/search/api/). The free tier gives 2000 queries/month.

### Custom Providers

Three ways to add your own search engine:

#### 1. From another pi extension (event bus)

```typescript
pi.events.emit("web-research:register-provider", {
  name: "my-search",
  description: "My custom search engine",
  isAvailable: () => Boolean(process.env.MY_API_KEY),
  search: async (query, opts) => {
    // call your API
    return [{ title: "...", url: "...", snippet: "..." }];
  },
});
```

#### 2. File-based discovery

Drop a `.ts` or `.js` file in `~/.pi/agent/search-providers/` or `.pi/search-providers/`:

```typescript
// ~/.pi/agent/search-providers/serper.ts
export default {
  name: "serper",
  description: "Serper.dev Google Search API",
  isAvailable: () => Boolean(process.env.SERPER_API_KEY),
  search: async (query, opts) => {
    const res = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: opts?.count ?? 5 }),
    });
    const data = await res.json();
    return data.organic.map((r) => ({
      title: r.title,
      url: r.link,
      snippet: r.snippet,
    }));
  },
};
```

#### 3. Built-in auto-detect

Set the right env var and the built-in provider activates automatically:

| Provider | Env Var | Status |
|----------|---------|--------|
| Brave Search | `BRAVE_API_KEY` | ✅ Built-in |

### Check available providers

Use the `/search-providers` command in pi to list what's configured.

## Works Without Search

No API key? No problem. `fetch_url` always works — just give it URLs directly. And `web_research` works with explicit URLs too:

```
Research these pages about RDS Proxy:
- https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/rds-proxy.html
- https://www.pulumi.com/registry/packages/aws/api-docs/rds/proxy/
```

## Development

```bash
git clone https://github.com/AYM-TECH/pi-surf
cd pi-surf
npm install

# Run unit tests (no network)
npm test

# Run live fetch tests (requires internet)
npm run test:live

# Run SDK integration tests (requires pi installed)
npm run test:sdk

# Run everything
npm run test:all
```

## License

MIT
