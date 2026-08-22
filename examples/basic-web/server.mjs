import { Buffer } from "node:buffer"
import { createServer } from "node:http"
import process from "node:process"
import { URL } from "node:url"

const host = "127.0.0.1"
const port = 3210

const page = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>UI Eval Basic Web Example</title>
    <style>
      :root {
        color-scheme: light;
        font-family: system-ui, sans-serif;
        background: #f4f7fb;
        color: #172033;
      }

      body {
        margin: 0;
      }

      main {
        box-sizing: border-box;
        width: min(720px, calc(100% - 48px));
        margin: 96px auto;
        padding: 48px;
        border: 1px solid #dbe3ef;
        border-radius: 16px;
        background: #ffffff;
        box-shadow: 0 16px 48px rgb(23 32 51 / 8%);
      }

      h1 {
        margin: 0 0 16px;
        font-size: 2rem;
        line-height: 1.2;
      }

      p {
        margin: 0;
        color: #526078;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>UI Eval Basic Web Example</h1>
      <p>A dependency-free page for exercising the UI Eval capture pipeline.</p>
    </main>
  </body>
</html>
`

const pageLength = Buffer.byteLength(page)

const server = createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, {
      Allow: "GET, HEAD",
      "Content-Type": "text/plain; charset=utf-8",
    })
    response.end("Method Not Allowed\n")
    return
  }

  let pathname
  try {
    pathname = new URL(request.url ?? "/", `http://${host}:${port}`).pathname
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" })
    response.end("Bad Request\n")
    return
  }

  if (pathname === "/favicon.ico") {
    response.writeHead(204, { "Cache-Control": "no-store" })
    response.end()
    return
  }

  if (pathname !== "/" && pathname !== "/index.html") {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    response.end("Not Found\n")
    return
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Length": String(pageLength),
    "Content-Type": "text/html; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  })
  response.end(request.method === "HEAD" ? undefined : page)
})

let stopping = false
function stop() {
  if (stopping) return
  stopping = true
  server.close((error) => {
    process.exitCode = error ? 1 : 0
  })
}

process.once("SIGINT", stop)
process.once("SIGTERM", stop)

server.listen(port, host, () => {
  process.stdout.write(`Basic Web example listening on http://${host}:${port}\n`)
})
