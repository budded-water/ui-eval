import { createHash } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { marked } from "marked"

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const outputPath = resolve(repositoryRoot, "docs/index.html")
const documents = [
  ["architecture", "Architecture", "docs/architecture.md"],
  ["contracts", "Contracts", "docs/contracts.md"],
  ["security", "Security model", "docs/security-model.md"],
  ["integration", "Integration", "docs/integration.md"],
  ["execution-profiles", "Local and remote evaluation", "docs/execution-profiles.md"],
  ["limitations", "Limitations", "docs/limitations.md"],
  ["development", "Development", "docs/development.md"],
  ["release", "Release", "docs/release.md"],
  ["roadmap", "Roadmap", "docs/roadmap.md"],
  [
    "adr-0001",
    "ADR 0001: standalone modular monolith",
    "docs/adr/0001-standalone-modular-monolith.md",
  ],
  [
    "adr-0002",
    "ADR 0002: design constraint contract",
    "docs/adr/0002-design-constraint-contract.md",
  ],
  ["adr-0003", "ADR 0003: execution profiles and bounded scope", "docs/adr/0003-execution-profiles-and-bounded-scope.md"],
]

const sources = await Promise.all(
  documents.map(async ([id, title, relativePath]) => ({
    id,
    title,
    relativePath,
    markdown: await readFile(resolve(repositoryRoot, relativePath), "utf8"),
  })),
)
const sourceDigest = createHash("sha256")
  .update(
    sources
      .map(({ relativePath, markdown }) => `${relativePath}\0${markdown}`)
      .join("\0"),
  )
  .digest("hex")

const navigation = sources
  .map(({ id, title }) => `<a href="#${id}">${title}</a>`)
  .join("\n")
const content = sources
  .map(
    ({ id, title, relativePath, markdown }) => `<section id="${id}" class="document">
        <div class="source"><span>${title}</span><code>${relativePath}</code></div>
        ${marked.parse(markdown)}
      </section>`,
  )
  .join("\n")

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="source-sha256" content="${sourceDigest}">
  <title>UI Eval technical documentation</title>
  <style>
    :root { color-scheme: light; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #f4f6fb; color: #172033; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    .layout { display: grid; grid-template-columns: minmax(220px, 280px) minmax(0, 920px); gap: 40px; width: min(1280px, calc(100% - 40px)); margin: 0 auto; padding: 32px 0 80px; }
    nav { position: sticky; top: 24px; align-self: start; max-height: calc(100vh - 48px); overflow: auto; padding: 20px; border: 1px solid #d9e0ec; border-radius: 14px; background: #fff; }
    nav strong { display: block; margin-bottom: 12px; font-size: 1.05rem; }
    nav a { display: block; padding: 7px 0; color: #3156a3; text-decoration: none; }
    nav a:hover { text-decoration: underline; }
    main { min-width: 0; }
    .hero, .document { margin-bottom: 24px; padding: clamp(24px, 4vw, 52px); border: 1px solid #d9e0ec; border-radius: 18px; background: #fff; box-shadow: 0 14px 40px rgb(23 32 51 / 6%); }
    .hero h1 { margin-top: 0; font-size: clamp(2rem, 5vw, 3.5rem); }
    .hero p { max-width: 68ch; color: #536079; font-size: 1.1rem; line-height: 1.7; }
    .source { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px; padding-bottom: 16px; border-bottom: 1px solid #e5eaf2; color: #65718a; }
    h1, h2, h3, h4 { scroll-margin-top: 24px; line-height: 1.2; }
    h1 { margin-top: 0; }
    h2 { margin-top: 2.2em; }
    p, li { line-height: 1.72; }
    a { color: #3156a3; }
    pre { overflow: auto; padding: 18px; border-radius: 12px; background: #111827; color: #e5edf9; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9em; }
    :not(pre) > code { padding: .15em .38em; border-radius: 5px; background: #edf1f7; }
    table { display: block; width: 100%; overflow-x: auto; border-collapse: collapse; }
    th, td { padding: 10px 12px; border: 1px solid #d9e0ec; text-align: left; vertical-align: top; }
    blockquote { margin-left: 0; padding-left: 18px; border-left: 4px solid #7896d1; color: #536079; }
    footer, .source code { overflow-wrap: anywhere; word-break: break-word; }
    footer { color: #65718a; font-size: .88rem; }
    @media (max-width: 860px) { .layout { display: block; width: min(100% - 24px, 920px); } nav { position: static; margin-bottom: 24px; } }
    @media print { nav { display: none; } .layout { display: block; width: auto; padding: 0; } .hero, .document { border: 0; box-shadow: none; break-inside: avoid; } }
  </style>
</head>
<body>
  <div class="layout">
    <nav><strong>UI Eval docs</strong>${navigation}</nav>
    <main>
      <header class="hero">
        <h1>UI Eval technical documentation</h1>
        <p>Generated reading view for the standalone evidence-first UI conformance engine. The linked Markdown files are canonical; this HTML is rebuilt and checked in CI.</p>
        <footer>Source set SHA-256: ${sourceDigest}</footer>
      </header>
      ${content}
    </main>
  </div>
</body>
</html>
`

if (process.argv.includes("--check")) {
  const existing = await readFile(outputPath, "utf8").catch(() => "")
  if (existing !== html) {
    process.stderr.write("docs/index.html is stale; run bun run docs:generate.\n")
    process.exitCode = 1
  }
} else {
  await writeFile(outputPath, html, "utf8")
  process.stdout.write(`Generated docs/index.html (${sourceDigest}).\n`)
}
