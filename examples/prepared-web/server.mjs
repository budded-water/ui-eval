import { createServer } from "node:http"
import { readFile } from "node:fs/promises"

const project = JSON.parse(await readFile("ui-eval/project.json", "utf8"))
const origin = new URL(project.devServer.url)
const page = await readFile(".ui-eval/site/index.html")
const server = createServer((request, response) => {
  if (request.url === "/favicon.ico") { response.writeHead(204); response.end(); return }
  if (request.url !== "/") { response.writeHead(404); response.end(); return }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": page.length }); response.end(page)
})
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { server.close(); server.closeAllConnections() })
server.listen(Number(origin.port), origin.hostname)
