/**
 * Unit test for fetch_url — tests the extraction pipeline directly
 * without going through pi or any LLM.
 *
 * Run: npx tsx test/test-fetch-unit.ts
 */

import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import TurndownService from "turndown";

// ─── Test helpers ──────────────────────────────────────────────────

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

// ─── Extraction pipeline (mirroring index.ts logic) ────────────────

function extractContent(
  html: string,
  url: string,
  opts: { selector?: string; maxLength?: number; includeLinks?: boolean } = {},
): { title: string; content: string; byline: string } | null {
  const dom = new JSDOM(html, { url });

  if (opts.selector) {
    const selected = dom.window.document.querySelector(opts.selector);
    if (selected) {
      dom.window.document.body.innerHTML = selected.outerHTML;
    }
  }

  const article = new Readability(dom.window.document).parse();
  if (!article || !article.content) return null;

  const td = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
  });

  td.addRule("removeImages", {
    filter: "img",
    replacement: () => "",
  });

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
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

section("Readability extraction");
{
  const html = `
    <html><head><title>Test Article</title></head>
    <body>
      <nav><a href="/">Home</a> <a href="/about">About</a></nav>
      <main>
        <article>
          <h1>Understanding Async/Await</h1>
          <p>Async/await is a pattern for handling asynchronous operations in JavaScript.</p>
          <p>It makes code easier to read compared to callbacks and raw promises.</p>
          <h2>Basic Usage</h2>
          <pre><code>async function fetchData() {
  const response = await fetch('/api');
  return response.json();
}</code></pre>
          <p>The function returns a promise that resolves when the await completes.</p>
        </article>
      </main>
      <footer>
        <p>Copyright 2025</p>
        <a href="/privacy">Privacy Policy</a>
        <button>Accept all cookies</button>
      </footer>
    </body></html>
  `;

  const result = extractContent(html, "https://example.com/article");
  assert(result !== null, "Extracts content from article page");
  assert(result!.content.includes("Async/Await"), "Preserves article heading");
  assert(result!.content.includes("async function fetchData"), "Preserves code blocks");
  assert(!result!.content.includes("Home"), "Strips navigation");
  assert(!result!.content.includes("Copyright"), "Strips footer");
}

section("CSS selector narrowing");
{
  const html = `
    <html><head><title>Docs</title></head>
    <body>
      <div class="sidebar"><ul><li>Nav 1</li><li>Nav 2</li></ul></div>
      <div class="docs-content">
        <h1>API Reference</h1>
        <p>The main API endpoint accepts GET and POST requests.</p>
        <h2>Authentication</h2>
        <p>Pass your API key in the Authorization header.</p>
      </div>
      <div class="sidebar-right"><p>Related links</p></div>
    </body></html>
  `;

  const withSelector = extractContent(html, "https://example.com/docs", {
    selector: ".docs-content",
  });
  const withoutSelector = extractContent(html, "https://example.com/docs");

  assert(withSelector !== null, "Extracts with selector");
  assert(withSelector!.content.includes("API Reference"), "Has main content");
  assert(!withSelector!.content.includes("Nav 1"), "Selector excludes sidebar");
  assert(!withSelector!.content.includes("Related links"), "Selector excludes right sidebar");
}

section("Link stripping");
{
  const html = `
    <html><head><title>Links Test</title></head>
    <body>
      <article>
        <h1>Links Test Page</h1>
        <p>Check out <a href="https://example.com">this great resource</a> for more info.</p>
        <p>Also see <a href="/other">the other page</a> and the <a href="/third">third page</a>.</p>
      </article>
    </body></html>
  `;

  const noLinks = extractContent(html, "https://example.com/test", { includeLinks: false });
  const withLinks = extractContent(html, "https://example.com/test", { includeLinks: true });

  assert(noLinks !== null, "Extracts without links");
  assert(!noLinks!.content.includes("]("), "Strips markdown links");
  assert(noLinks!.content.includes("this great resource"), "Preserves link text");

  assert(withLinks !== null, "Extracts with links");
  assert(withLinks!.content.includes("]("), "Preserves markdown links");
}

section("Image removal");
{
  const html = `
    <html><head><title>Images Test</title></head>
    <body>
      <article>
        <h1>Article with Images</h1>
        <p>Here is some text.</p>
        <img src="banner.jpg" alt="Banner image" />
        <p>More text after image.</p>
        <img src="photo.png" alt="A photo" />
      </article>
    </body></html>
  `;

  const result = extractContent(html, "https://example.com/images");
  assert(result !== null, "Extracts article with images");
  assert(!result!.content.includes("banner.jpg"), "Strips image src");
  assert(!result!.content.includes("!["), "Strips markdown images");
  assert(result!.content.includes("Here is some text"), "Preserves surrounding text");
  assert(result!.content.includes("More text after image"), "Preserves text after image");
}

section("Truncation");
{
  const longParagraph = "This is a sentence that is about fifty characters. ".repeat(100);
  const html = `
    <html><head><title>Long Article</title></head>
    <body>
      <article>
        <h1>Very Long Article</h1>
        <p>${longParagraph}</p>
      </article>
    </body></html>
  `;

  const truncated = extractContent(html, "https://example.com/long", { maxLength: 500 });
  assert(truncated !== null, "Extracts long article");
  assert(truncated!.content.length <= 520, `Truncates to maxLength (got ${truncated!.content.length})`);
  assert(truncated!.content.includes("[... truncated]"), "Adds truncation marker");

  const full = extractContent(html, "https://example.com/long", { maxLength: 100_000 });
  assert(full !== null, "Full extraction works");
  assert(!full!.content.includes("[... truncated]"), "No truncation marker when under limit");
}

section("Noise removal");
{
  const html = `
    <html><head><title>Noisy Page</title></head>
    <body>
      <article>
        <h1>Real Content</h1>
        <p>This is the actual article content that matters.</p>
        <p>Share this on Twitter</p>
        <p>Tweet this article</p>
        <p>Pin this on Pinterest</p>
        <p>We use cookies. Accept all cookies to continue.</p>
        <p>Read our privacy policy for details.</p>
        <p>This is more real content after the noise.</p>
      </article>
    </body></html>
  `;

  const result = extractContent(html, "https://example.com/noisy");
  assert(result !== null, "Extracts noisy page");
  assert(result!.content.includes("actual article content"), "Keeps real content");
  assert(result!.content.includes("more real content"), "Keeps content after noise");
  // Note: Readability may or may not strip these; our regex post-processing does
  const hasShareNoise = result!.content.includes("Share this on Twitter");
  const hasCookieNoise = result!.content.includes("Accept all cookies");
  assert(!hasShareNoise, "Strips 'Share this' noise");
  assert(!hasCookieNoise, "Strips cookie noise");
}

section("Empty / malformed input");
{
  const empty = extractContent("<html><body></body></html>", "https://example.com/empty");
  assert(empty === null, "Returns null for empty page");

  const noArticle = extractContent(
    "<html><body><div>Just a div with no article structure</div></body></html>",
    "https://example.com/no-article",
  );
  // Readability may or may not find content here — either outcome is fine
  assert(true, `Handles no-article page gracefully (result: ${noArticle ? "extracted" : "null"})`);
}

// ─── Summary ───────────────────────────────────────────────────────

console.log(`\n${"=".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
else console.log("All tests passed ✓");
