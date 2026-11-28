import { constants } from "node:fs"
import { lstat, open, writeFile } from "node:fs/promises"
import { basename, dirname, resolve } from "node:path"
import { escapeHtml } from "./render"

const maxRecordBytes = 1024 * 1024
const localPng = /^[a-z0-9][a-z0-9._-]*\.png$/i
const nonempty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

export async function writeSupplementalReport(cwd: string, input: string): Promise<string> {
  const path = resolve(cwd, input)
  if (!path.endsWith(".json")) throw new Error("Supplemental record must be a JSON file")
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let record: unknown
  try {
    const stat = await file.stat()
    if (!stat.isFile() || stat.size > maxRecordBytes) throw new Error("Supplemental record must be a regular file of at most 1 MiB")
    const bytes = Buffer.alloc(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
      if (bytesRead === 0) throw new Error("Supplemental record was truncated")
      offset += bytesRead
    }
    if ((await file.stat()).size !== stat.size) throw new Error("Supplemental record changed during reading")
    record = JSON.parse(bytes.toString("utf8"))
  } finally {
    await file.close()
  }
  if (!record || typeof record !== "object" || Array.isArray(record)) throw new Error("Invalid supplemental record")
  const { title, method, scope, source, status, observations, screenshots } = record as Record<string, unknown>
  if (!nonempty(title) || !nonempty(method) || !nonempty(scope) || !nonempty(source) ||
      (status !== "passed" && status !== "failed" && status !== "inconclusive") ||
      !Array.isArray(observations) || !observations.every(nonempty) ||
      !Array.isArray(screenshots) || !screenshots.every(name => nonempty(name) && localPng.test(name))) {
    throw new Error("Invalid supplemental record fields")
  }
  const directory = dirname(path)
  for (const name of screenshots) {
    if (!(await lstat(resolve(directory, name))).isFile()) throw new Error("Screenshot must be a regular PNG beside the record")
  }
  const output = path.slice(0, -".json".length) + ".html"
  const e = escapeHtml
  await writeFile(output, `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self'; style-src 'unsafe-inline'">
<title>${e(title)}</title>
<style>body{font:16px/1.6 system-ui;max-width:840px;margin:32px auto;padding:0 20px;overflow-wrap:anywhere}img{max-width:min(100%,360px);height:auto}</style>
<h1>${e(title)}</h1>
<p>Supplemental evidence · Reported outcome: <strong>${status}</strong></p>
<p>This view renders an externally collected record. It does not establish suite acceptance.</p>
<dl><dt>Method</dt><dd>${e(method)}</dd><dt>Scope</dt><dd>${e(scope)}</dd><dt>Source</dt><dd><code>${e(source)}</code></dd></dl>
<h2>Observations</h2><ul>${observations.map(item => `<li>${e(item)}</li>`).join("")}</ul>
${screenshots.map(name => `<figure><img src="./${name}" alt="${name}"><figcaption>${name}</figcaption></figure>`).join("")}
<p><a href="./${e(encodeURIComponent(basename(path)))}">Source JSON record</a></p>
</html>\n`, { flag: "wx" })
  return output
}
