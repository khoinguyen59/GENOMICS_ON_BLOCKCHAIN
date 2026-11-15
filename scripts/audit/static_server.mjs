// Agent4 throwaway static server + POST sink (port 5199) so headless Chrome can load real project modules.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
const ROOT = process.cwd();
const OUT = path.join(ROOT, "test", "adversarial", "agent4", "browser_probe_result.txt");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8", ".json": "application/json" };
const srv = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/agent4-probe-log") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => { fs.writeFileSync(OUT, body); res.writeHead(204); res.end(); });
    return;
  }
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  fs.readFile(p, (err, buf) => {
    if (err) { res.writeHead(404); res.end("nf"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store" });
    res.end(buf);
  });
});
srv.listen(5199, "127.0.0.1", () => console.log("AGENT4_SERVER_READY"));
