/**
 * Live integration test for fetch_url — hits real URLs
 * to verify the full pipeline works end-to-end.
 *
 * Run: npx tsx test/test-fetch-live.ts
 *
 * These tests hit the network, so they may be flaky if sites change.
 * They're meant for manual verification, not CI.
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

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

// ─── Fetch + extract (same logic as the extension) ─────────────────

async function fetchAndExtract(
  url: string,
  opts: { selector?: string; maxLength?: number; includeLinks?: boolean } = {},
): Promise<{ title: string; content: string; length: number } | null> {
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
      },
      redirect: "follow",
    });
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html")) {
    const raw = await response.text();
    return { title: url, content: raw.slice(0, opts.maxLength ?? 15_000), length: raw.length };
  }

  const html = await response.text();
  const dom = new JSDOM(html, { url });

  if (opts.selector) {
    const selected = dom.window.document.querySelector(opts.selector);
    if (selected) dom.window.document.body.innerHTML = selected.outerHTML;
  }

  const article = new Readability(dom.window.document).parse();
  if (!article?.content) return null;

  const td = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced", bulletListMarker: "-" });
  td.addRule("removeImages", { filter: "img", replacement: () => "" });
  if (!opts.includeLinks) {
    td.addRule("stripLinks", {
      filter: "a",
      replacement: (_c: string, node: any) => node.textContent || "",
    });
  }

  let md = td.turndown(article.content)
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^#+\s*$/gm, "")
    .replace(/^(Share|Tweet|Pin|Email|Print)(\s+(this|on|via))?.{0,20}$/gim, "")
    .replace(/^.*(cookie|consent|privacy policy|accept all).*$/gim, "")
    .trim();

  const maxLen = opts.maxLength ?? 15_000;
  if (md.length > maxLen) md = md.slice(0, maxLen) + "\n\n[... truncated]";

  return { title: article.title || "", content: md, length: article.length || md.length };
}

// ─── Tests ─────────────────────────────────────────────────────────

async function run() {
  section("Python docs — standard documentation page");
  {
    const result = await fetchAndExtract("https://docs.python.org/3/library/json.html", {
      selector: "main",
      maxLength: 5000,
    });
    assert(result !== null, "Fetched Python json docs");
    assert(result!.content.includes("json"), "Contains json module content");
    assert(result!.content.includes("dump"), "Contains json.dump reference");
    assert(!result!.content.includes("Navigation"), "No navigation noise");
    console.log(`    → ${result!.content.length} chars, title: "${result!.title}"`);
  }

  section("GitHub README — complex page with lots of chrome");
  {
    const result = await fetchAndExtract("https://github.com/badlogic/pi-mono", {
      maxLength: 5000,
    });
    assert(result !== null, "Fetched GitHub repo page");
    if (result) {
      // GitHub pages are tricky — just verify we got something reasonable
      assert(result.content.length > 100, `Got meaningful content (${result.content.length} chars)`);
      console.log(`    → ${result.content.length} chars, title: "${result.title}"`);
    }
  }

  section("JSON API endpoint — non-HTML content");
  {
    const result = await fetchAndExtract("https://httpbin.org/json");
    assert(result !== null, "Fetched JSON endpoint");
    if (result) {
      assert(result.content.includes("slideshow"), "Contains JSON data");
      console.log(`    → ${result.content.length} chars`);
    }
  }

  section("MDN — heavy docs page with sidebar");
  {
    const result = await fetchAndExtract(
      "https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Promise",
      { selector: "main", maxLength: 8000 },
    );
    assert(result !== null, "Fetched MDN Promise docs");
    if (result) {
      assert(result.content.includes("Promise"), "Contains Promise content");
      assert(result.content.length > 500, `Got substantial content (${result.content.length} chars)`);
      console.log(`    → ${result.content.length} chars, title: "${result.title}"`);
    }
  }

  section("Truncation at small maxLength");
  {
    const result = await fetchAndExtract("https://docs.python.org/3/library/json.html", {
      selector: "main",
      maxLength: 200,
    });
    assert(result !== null, "Fetched with small maxLength");
    if (result) {
      assert(result.content.length <= 220, `Respects maxLength (got ${result.content.length})`);
      assert(result.content.includes("[... truncated]"), "Has truncation marker");
    }
  }

  section("404 / error handling");
  {
    try {
      await fetchAndExtract("https://httpbin.org/status/404");
      assert(false, "Should have thrown on 404");
    } catch (err: any) {
      assert(err.message.includes("404"), `Throws on 404: ${err.message}`);
    }
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
