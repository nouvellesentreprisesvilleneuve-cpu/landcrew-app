// LandCrew — hôte autonome Node.js (hébergement WHC / cPanel / Passenger)
//
// Rôle : servir la vraie application LandCrew (celle qui enregistre) hors
// de Muse, sous https://app.landcrew.ca/.
//   - GET  /            → le client web (public/), avec injection du
//                         manifeste PWA et du service worker.
//   - POST /actions     → le même protocole RPC que le runtime Muse :
//                         corps { action, args } → réponse { data } ou
//                         { error }. Validation zod à l'entrée et à la
//                         sortie, exactement comme le worker Muse.
//   - Les données vivent dans un fichier SQLite local (data/landcrew.db),
//     accédé via drizzle-orm/libsql, comme le runtime local de Muse.
//
// Aucune dépendance à Muse : les seules librairies requises sont
// drizzle-orm et @libsql/client (voir package.json).
//
// Démarrage (cPanel « Setup Node.js App ») : ce fichier est le fichier de
// démarrage (startup file). Passenger fournit PORT ; en local, PORT ou
// 3000 par défaut.

"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");
const { drizzle } = require("drizzle-orm/libsql");
const { Actions } = require("./actions.bundle.cjs");

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DB_PATH =
  process.env.LANDCREW_DB_PATH || path.join(ROOT, "data", "landcrew.db");

// ---------------------------------------------------------------- base de
// données : création + migrations (les mêmes fichiers SQL que l'artefact
// Muse, appliqués en ordre, une seule fois chacun).

const client = createClient({ url: `file:${DB_PATH}` });
const db = drizzle(client);

async function migrate() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  await client.execute(
    "CREATE TABLE IF NOT EXISTS __landcrew_migrations " +
      "(name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  const done = new Set(
    (await client.execute("SELECT name FROM __landcrew_migrations")).rows.map(
      (r) => r.name,
    ),
  );
  const migDir = path.join(ROOT, "migrations");
  const files = fs
    .readdirSync(migDir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(migDir, file), "utf8");
    const statements = sql
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statements.length > 0) {
      await client.batch(
        statements.map((s) => ({ sql: s, args: [] })),
        "write",
      );
    }
    await client.execute({
      sql: "INSERT INTO __landcrew_migrations (name, applied_at) VALUES (?, ?)",
      args: [file, new Date().toISOString()],
    });
    console.log(`[landcrew] migration appliquée : ${file}`);
  }
}

// ---------------------------------------------------------------- contexte
// d'exécution des actions. Fait vérifié dans le code source : les handlers
// de LandCrew n'utilisent que ctx.db() et ctx.invalidateQueries(). Les
// autres champs du contrat Muse sont fournis en talons (stubs) qui
// lèvent une erreur claire s'ils étaient un jour appelés.

function notSupported(what) {
  return () => {
    throw new Error(`${what} n'est pas disponible dans l'hébergement autonome`);
  };
}

function makeCtx(sessionToken) {
  return {
    slug: "landcrew",
    invocationId: `whc-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 10)}`,
    spaceDir: ROOT,
    // Multi-entreprise : le jeton de session du client (en-tête
    // « x-landcrew-session ») et le marqueur d'hôte autonome — sans
    // session valide, les actions métier sont refusées (voir la garde
    // dans handleAction) et les actions lisent la compagnie du jeton.
    sessionToken: sessionToken ?? undefined,
    hostStandalone: true,
    db: () => db,
    viewer: undefined,
    blobs: {
      put: notSupported("ctx.blobs.put"),
      getUrl: notSupported("ctx.blobs.getUrl"),
      delete: notSupported("ctx.blobs.delete"),
      head: async () => null,
      list: async () => [],
    },
    agent: {
      spawnTask: async () => ({
        ok: false,
        error: "ctx.agent n'est pas disponible dans l'hébergement autonome",
      }),
      send: async () => ({
        ok: false,
        error: "ctx.agent n'est pas disponible dans l'hébergement autonome",
      }),
      status: async () => ({ taskId: "", status: "not_found" }),
    },
    inference: { complete: notSupported("ctx.inference.complete") },
    tool: {},
    emit: () => {},
    invalidateQueries: () => {},
    executePrivileged: notSupported("ctx.executePrivileged"),
  };
}

// ---------------------------------------------------------------- HTTP

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".woff2": "font/woff2",
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

// Actions accessibles sans session : l'accès lui-même (inscription,
// connexion, code d'entreprise) et l'espace CLIENT public de
// l'annuaire (les demandes sont routées vers la bonne entreprise
// côté serveur).
const PUBLIC_ACTIONS = new Set([
  "registerCompany",
  "loginCompany",
  "loginEmployee",
  "getJoinCompany",
  "getSession",
  "logout",
  "listDirectoryListings",
  "registerClientAccount",
  "getClientAccount",
  "updateClientAccount",
  "listMyClientRequests",
  "createQuoteRequest",
  "geocodeAddress",
]);

async function handleAction(req, res) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let payload;
  try {
    payload = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 200, { error: "Corps de requête JSON invalide" });
  }
  const def = Actions[payload.action];
  if (!def || typeof def.handler !== "function") {
    return sendJson(res, 200, {
      error: `Action inconnue : ${String(payload.action)}`,
    });
  }
  // Multi-entreprise : hors actions publiques, un jeton de session
  // valide est exigé — chaque compagnie ne voit que SON espace.
  const rawToken = req.headers["x-landcrew-session"];
  const sessionToken =
    typeof rawToken === "string" && rawToken ? rawToken : null;
  if (!PUBLIC_ACTIONS.has(payload.action)) {
    let valid = false;
    if (sessionToken) {
      try {
        const rs = await client.execute({
          sql: "SELECT expires_at FROM sessions WHERE token = ?",
          args: [sessionToken],
        });
        const row = rs.rows[0];
        if (row && Number(row.expires_at) > Date.now()) valid = true;
      } catch {
        valid = false;
      }
    }
    if (!valid) {
      return sendJson(res, 200, {
        error: "Session requise — connectez-vous à votre entreprise.",
      });
    }
  }
  try {
    const args = def.request.parse(payload.args ?? {});
    const result = await def.handler(makeCtx(sessionToken), args);
    const data = def.response.parse(result);
    return sendJson(res, 200, { data });
  } catch (e) {
    return sendJson(res, 200, {
      error: e && e.message ? e.message : String(e),
    });
  }
}

let indexHtmlCache = null;
function indexHtml() {
  if (indexHtmlCache) return indexHtmlCache;
  let html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  // Manifeste PWA réel (requis par la TWA Google Play) + enregistrement du
  // service worker. Injectés ici, dans la copie servie, sans modifier les
  // fichiers de l'artefact Muse. Le lien est placé tôt dans <head> pour
  // primer sur le manifeste injecté en JS par l'application elle-même.
  const inject =
    '<link rel="manifest" href="/manifest.webmanifest" />' +
    "<script>if('serviceWorker' in navigator){window.addEventListener('load'," +
    "function(){navigator.serviceWorker.register('/sw.js').catch(function(){})});}</script>";
  if (!html.includes('rel="manifest"')) {
    html = html.replace(/<head>/i, "<head>" + inject);
  }
  indexHtmlCache = html;
  return html;
}

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("Forbidden");
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    if (rel === "index.html") {
      const body = indexHtml();
      res.writeHead(200, {
        "content-type": MIME[".html"],
        "content-length": Buffer.byteLength(body),
      });
      return res.end(body);
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "cache-control": rel.startsWith("assets/")
        ? "public, max-age=31536000, immutable"
        : "public, max-age=3600",
    });
    return fs.createReadStream(filePath).pipe(res);
  }
  // Repli SPA : toute autre adresse sert l'application (une seule page).
  const body = indexHtml();
  res.writeHead(200, {
    "content-type": MIME[".html"],
    "content-length": Buffer.byteLength(body),
  });
  return res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (req.method === "POST" && url.pathname === "/actions") {
    handleAction(req, res).catch((e) => {
      console.error("[landcrew] erreur /actions", e);
      sendJson(res, 200, { error: String(e && e.message ? e.message : e) });
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    return sendJson(res, 200, { ok: true, app: "landcrew" });
  }
  if (req.method === "GET" || req.method === "HEAD") {
    return serveStatic(req, res, url.pathname);
  }
  res.writeHead(405);
  res.end("Method Not Allowed");
});

async function main() {
  await migrate();
  const portEnv = process.env.PORT;
  const onReady = () =>
    console.log(`[landcrew] en écoute (PORT=${portEnv || 3000})`);
  if (portEnv && /^\d+$/.test(portEnv)) {
    server.listen(Number(portEnv), "0.0.0.0", onReady);
  } else if (portEnv) {
    // Passenger peut fournir un chemin de socket Unix dans PORT.
    server.listen(portEnv, onReady);
  } else {
    server.listen(3000, "0.0.0.0", onReady);
  }
}

main().catch((e) => {
  console.error("[landcrew] échec de démarrage", e);
  process.exit(1);
});
