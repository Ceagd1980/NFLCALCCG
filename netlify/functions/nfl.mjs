// Radar NFL — función de Netlify que lee TeamRankings.com y devuelve JSON.
// Sin dependencias externas: usa fetch nativo (Node 18+) y un lector de tablas HTML propio.

const BASE = "https://www.teamrankings.com/nfl";
const URLS = {
  schedule: `${BASE}/schedules/season/`,
  standings: `${BASE}/standings/`,
  pts: `${BASE}/stat/points-per-game`,
  td: `${BASE}/stat/touchdowns-per-game`,
  ypp: `${BASE}/stat/yards-per-point`,
  yds: `${BASE}/stat/yards-per-game`,
};
const STAT_KEYS = ["pts", "td", "ypp", "yds"];

// Estadísticas de jugadores (orden = orden de las columnas en la página)
const PLAYER_STATS = {
  td: `${BASE}/player-stat/total-touchdowns`,
  rush: `${BASE}/player-stat/rushing-net-yards`,
  pass: `${BASE}/player-stat/passing-plays-completed`,
  fg: `${BASE}/player-stat/scoring-field-goals`,
  punt: `${BASE}/player-stat/punting-plays`,
};
const PLAYER_KEYS = Object.keys(PLAYER_STATS);
const TOP_PLAYERS = 5;

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

// Nombres equivalentes (TeamRankings usa "NY Jets", "LA Rams", "LA Chargers", etc.)
const ALIAS_GROUPS = [
  ["nyjets", "newyorkjets", "jets", "nyj"],
  ["nygiants", "newyorkgiants", "giants", "nyg"],
  ["larams", "losangelesrams", "rams", "lar"],
  ["lachargers", "losangeleschargers", "chargers", "lac"],
  ["lasvegas", "lasvegasraiders", "raiders", "lv"],
  ["washington", "washingtoncommanders", "commanders", "was", "wsh"],
  ["sanfrancisco", "sanfrancisco", "ers", "sf"],
  ["newengland", "newenglandpatriots", "patriots", "ne"],
  ["kansascity", "kansascitychiefs", "chiefs", "kc"],
  ["tampabay", "tampabaybuccaneers", "buccaneers", "tb"],
  ["greenbay", "greenbaypackers", "packers", "gb"],
  ["neworleans", "neworleanssaints", "saints", "no"],
];
const ALIAS = {};
for (const g of ALIAS_GROUPS) for (const k of g) ALIAS[k] = g[0];

const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z]/g, "");
const key = (s) => { const k = norm(s); return ALIAS[k] || k; };
const pkey = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z]/g, "");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------- descarga con reintento y límite de tiempo ----------
async function getHtml(url, tries = 2, timeoutMs = 3500) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (!/<table/i.test(html)) throw new Error("la página no trae tablas (posible bloqueo)");
      return html;
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("tiempo de espera agotado") : e;
      if (i < tries - 1) await sleep(350);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr ? lastErr.message : "error desconocido");
}

// ---------- lector de tablas HTML ----------
function decode(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(html) {
  const out = [];
  const reTable = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = reTable.exec(html))) {
    const rows = [];
    const reRow = /<tr[\s\S]*?<\/tr>/gi;
    let r;
    while ((r = reRow.exec(m[0]))) {
      const cells = [];
      const reCell = /<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi;
      let c;
      while ((c = reCell.exec(r[0]))) cells.push(decode(c[2]));
      if (cells.length) rows.push(cells);
    }
    out.push({ index: m.index, rows });
  }
  return out;
}

// ---------- calendario de la temporada ----------
// Formato: filas de fecha ("Sun Sep 13 | Time | Location") seguidas de partidos
// ("Buffalo @ Houston | 1:00 PM | Reliant Stadium"). "vs." = campo neutral.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function seasonYear(html) {
  const m = /(\d{4})\s+NFL\s+Schedule/i.exec(html);
  if (m) return +m[1];
  const d = new Date();
  return d.getUTCMonth() < 3 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

function toIso(label, year) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(label || "");
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  const y = mo <= 3 ? year + 1 : year; // enero-marzo = playoffs, año siguiente
  return `${y}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
}

const cleanTeam = (s) => s.replace(/\(\d+-\d+(-\d+)?\)/g, "").replace(/^#\d+\s+/, "").replace(/\s+\d+$/, "").trim();

function parseSchedule(html) {
  const year = seasonYear(html);
  const games = [];
  const tables = parseTables(html).filter((t) =>
    t.rows.some((r) => r.some((c) => /\s(@|at|vs\.?)\s/i.test(c)))
  );
  for (const t of tables) {
    let dateLabel = "", iso = null, iTime = 1, iLoc = 2;
    for (const r of t.rows) {
      const first = r[0] || "";
      // Fila de fecha / cabecera
      if (r.some((c) => /^time$/i.test(c)) || (toIso(first, year) && !/\s(@|at|vs\.?)\s/i.test(first))) {
        if (toIso(first, year)) { dateLabel = first; iso = toIso(first, year); }
        const it = r.findIndex((c) => /^time$/i.test(c)), il = r.findIndex((c) => /location/i.test(c));
        if (it >= 0) iTime = it;
        if (il >= 0) iLoc = il;
        continue;
      }
      const mm = first.match(/^(.+?)\s+(@|at|vs\.?)\s+(.+)$/i);
      if (!mm) continue;
      games.push({
        date: iso,
        dateLabel,
        away: cleanTeam(mm[1]),
        home: cleanTeam(mm[3]),
        neutral: /^vs/i.test(mm[2]),
        time: r[iTime] || "",
        location: r[iLoc] || "",
      });
    }
  }
  return games;
}

// ---------- tabla de posiciones (8 divisiones) ----------
const ZONE = { east: "Este", north: "Norte", south: "Sur", west: "Oeste" };

function parseStandings(html) {
  const isHdr = (r) => r.some((c) => /streak/i.test(c)) && r.some((c) => /pct/i.test(c));
  const tables = parseTables(html).filter((t) => t.rows.some(isHdr));
  const map = {};
  tables.forEach((t, ti) => {
    const before = html.slice(Math.max(0, t.index - 2500), t.index);
    const all = [...before.matchAll(/\b(AFC|NFC)\s*(East|North|South|West)?\b/gi)];
    const last = all.length ? all[all.length - 1] : null;
    const conf = last ? last[1].toUpperCase() : ti < tables.length / 2 ? "AFC" : "NFC";

    const hdr = t.rows.find(isHdr);
    const idx = (re) => hdr.findIndex((c) => re.test(c));
    let iT = idx(/^team$/i);
    if (iT < 0) iT = 0;
    const iRank = idx(/^rank$/i), iWL = idx(/overall|^w-l/i), iPct = idx(/^pct$/i),
      iStreak = idx(/streak/i);

    // División: por filas de título dentro de la tabla, o por el texto previo a la tabla
    let div = last && last[2] ? `${conf} ${ZONE[last[2].toLowerCase()]}` : null;
    let pos = 0;
    const setDiv = (text) => {
      const m = /(?:\b(AFC|NFC)\s*)?\b(East|North|South|West)\b/i.exec(text);
      if (!m) return;
      div = `${m[1] ? m[1].toUpperCase() : conf} ${ZONE[m[2].toLowerCase()]}`;
      pos = 0;
    };

    for (const r of t.rows) {
      const isLabel = isHdr(r) || r.length < 3 || r.every((c) => !/\d/.test(c));
      if (isLabel) { setDiv(r.join(" ")); continue; }
      if (!r[iT]) continue;
      pos++;
      map[key(cleanTeam(r[iT]))] = {
        team: r[iT], pos, div: div || conf,
        powerRank: iRank >= 0 ? num(r[iRank]) : null,
        record: iWL >= 0 ? r[iWL] : "",
        pct: iPct >= 0 ? num(r[iPct]) : null,
        streak: iStreak >= 0 ? r[iStreak] : "",
      };
    }
  });
  if (!Object.keys(map).length) throw new Error("tabla de posiciones no encontrada");
  return map;
}

// ---------- páginas de estadística (Temporada, Last 3, Home, Away) ----------
function parseStat(html) {
  const isHdr = (r) => r.includes("Team") && r.includes("Home") && r.includes("Away");
  const t = parseTables(html).find((t) => t.rows.some(isHdr));
  if (!t) throw new Error("tabla de estadística no encontrada");
  const hdr = t.rows.find(isHdr);
  const iT = hdr.indexOf("Team"), iH = hdr.indexOf("Home"), iA = hdr.indexOf("Away"),
    iL3 = hdr.findIndex((c) => /last\s*3/i.test(c));
  let iS = hdr.findIndex((c, i) => i > iT && /^\d{4}$/.test(c)); // columna del año actual
  if (iS < 0) iS = iT + 1;

  const map = {};
  for (const r of t.rows) {
    if (isHdr(r) || !r[iT]) continue;
    map[key(cleanTeam(r[iT]))] = {
      season: num(r[iS]),
      last3: iL3 >= 0 ? num(r[iL3]) : null,
      home: num(r[iH]),
      away: num(r[iA]),
    };
  }
  return map;
}

// Búsqueda segura: exacta primero; parcial solo si hay UNA coincidencia (evita mezclar NY Jets / NY Giants)
// ---------- estadísticas de jugadores ----------
// Busca la tabla con columnas de jugador, equipo y valor. Si la cabecera no las nombra,
// las deduce del contenido (columna con nombres de personas, columna con equipos, última numérica).
const RE_PLAYER = /player|^name$|athlete/i;
const RE_TEAM = /team|school|college/i;
const RE_VALUE = /^value$|per\s*game|^avg|average|^ppg$|^apg$|^rpg$|^pts$|^ast$|^reb$|points|assists|rebounds/i;

function parsePlayers(html) {
  const tables = parseTables(html).filter((t) => t.rows.length >= 3);
  if (!tables.length) throw new Error("tabla de jugadores no encontrada");
  let best = null;
  for (const t of tables) {
    const hi = t.rows.findIndex((r) => r.some((c) => RE_PLAYER.test(c)) && r.some((c) => RE_TEAM.test(c)));
    let iP = -1, iT = -1, iV = -1, start = 0;
    if (hi >= 0) {
      const hdr = t.rows[hi];
      iP = hdr.findIndex((c) => RE_PLAYER.test(c));
      iT = hdr.findIndex((c, i) => i !== iP && RE_TEAM.test(c));
      iV = hdr.findIndex((c, i) => i !== iP && i !== iT && RE_VALUE.test(c));
      start = hi + 1;
    } else {
      // Deducción por contenido: texto sin dígitos en 2 columnas (jugador = la que tiene más palabras)
      const body = t.rows.filter((r) => r.length >= 3).slice(0, 30);
      if (body.length < 3) continue;
      const cols = Math.max(...body.map((r) => r.length));
      const textCols = [];
      for (let i = 0; i < cols; i++) {
        const vals = body.map((r) => r[i] || "");
        const txt = vals.filter((v) => /[a-z]/i.test(v) && !/\d/.test(v)).length;
        const avgLen = vals.reduce((n, v) => n + v.length, 0) / vals.length;
        // descarta columnas cortas tipo posición (G, F, C, G-F)
        if (txt >= body.length * 0.8 && avgLen > 3) textCols.push({ i, uniq: new Set(vals).size / vals.length });
      }
      if (textCols.length < 2) continue;
      // Jugador = la columna con más valores distintos (los equipos se repiten); empate = la primera
      textCols.sort((x, y) => y.uniq - x.uniq || x.i - y.i);
      iP = textCols[0].i; iT = textCols[1].i;
    }
    const byTeam = {};
    let n = 0;
    for (const r of t.rows.slice(start)) {
      if (!r[iP] || !r[iT] || RE_PLAYER.test(r[iP])) continue;
      let v = iV >= 0 ? num(r[iV]) : null;
      if (v == null) for (let i = r.length - 1; i >= 0; i--) { if (i === iP || i === iT) continue; v = num(r[i]); if (v != null) break; }
      if (v == null) continue;
      const tk = key(cleanTeam(r[iT]));
      (byTeam[tk] ||= {})[pkey(r[iP])] = { name: r[iP], team: r[iT], v };
      n++;
    }
    if (!best || n > best.n) best = { n, byTeam };
  }
  if (!best || !best.n) throw new Error("tabla de jugadores no encontrada");
  return best.byTeam;
}

// Las páginas de jugadores escriben el equipo con su apodo ("BYU Cougars", "Iowa State Cyclones",
// "North Carolina Tar Heels"). Se quita el apodo palabra por palabra desde el final hasta que el
// nombre coincide EXACTO con un equipo conocido; así "Iowa State Cyclones" nunca cae en "Iowa".
// La página de jugadores usa el nombre completo ("Kansas City Chiefs", "New York Jets",
// "San Francisco 49ers"). Se prueba el nombre entero y luego quitando el apodo (máx. 2 palabras)
// hasta que coincide EXACTO con un equipo conocido. Nunca "NY Jets" con "NY Giants".
function teamFromPlayerPage(raw, known) {
  const words = cleanTeam(raw).split(/\s+/).filter(Boolean);
  for (let drop = 0; drop <= 2 && drop < words.length; drop++) {
    const k = key(words.slice(0, words.length - drop).join(" "));
    if (k && known.has(k)) return { k, drop };
  }
  return null;
}

function remapAllPlayers(players, known) {
  const raws = new Map();
  for (const map of Object.values(players)) {
    if (!map) continue;
    for (const [rawKey, plist] of Object.entries(map)) {
      const team = Object.values(plist)[0].team;
      if (raws.has(team)) continue;
      raws.set(team, known.has(rawKey) ? { k: rawKey, drop: 0 } : teamFromPlayerPage(team, known));
    }
  }
  const bestDrop = {};
  for (const r of raws.values()) if (r) bestDrop[r.k] = Math.min(bestDrop[r.k] ?? 9, r.drop);
  const out = {};
  for (const [name, map] of Object.entries(players)) {
    if (!map) { out[name] = null; continue; }
    const m = {};
    for (const plist of Object.values(map)) {
      const r = raws.get(Object.values(plist)[0].team);
      if (!r || r.drop !== bestDrop[r.k]) continue;
      Object.assign((m[r.k] ||= {}), plist);
    }
    out[name] = m;
  }
  return out;
}

// En la NFL cada estadística la lidera un jugador distinto (QB pases, RB carrera, K goles de campo,
// P despejes). Se elige primero al líder del equipo en cada estadística (en orden: TD, carrera,
// pases, goles de campo, despejes) y luego se completa hasta 5 con los siguientes en TD y carrera.
function teamPlayers(players, tk) {
  const all = {};
  for (const s of PLAYER_KEYS) {
    const m = players[s]?.[tk];
    if (!m) continue;
    for (const [pk, p] of Object.entries(m)) {
      (all[pk] ||= { name: p.name, team: p.team })[s] = p.v;
    }
  }
  const ids = Object.keys(all);
  if (!ids.length) return null;
  const chosen = [];
  const add = (pk) => { if (pk && !chosen.includes(pk) && chosen.length < TOP_PLAYERS) chosen.push(pk); };
  const rank = (s) => ids.filter((pk) => all[pk][s] != null).sort((a, b) => all[b][s] - all[a][s]);
  for (const s of PLAYER_KEYS) add(rank(s)[0]);
  for (const s of ["td", "rush", "pass", "fg", "punt"]) for (const pk of rank(s)) add(pk);
  return chosen.map((pk) => {
    const p = all[pk];
    const o = { name: p.name, team: p.team };
    for (const s of PLAYER_KEYS) o[s] = p[s] ?? null;
    return o;
  });
}

// Diagnóstico: /api/nfl?debug=players muestra cómo vienen las páginas de jugadores
async function debugPlayers() {
  const out = {};
  await Promise.all(Object.entries(PLAYER_STATS).map(async ([k, u]) => {
    try {
      const r = await fetch(u, { headers: HEADERS });
      const html = await r.text();
      const tables = parseTables(html);
      out[k] = {
        url: u, status: r.status, bytes: html.length, tables: tables.length,
        muestra: tables.slice(0, 3).map((t) => ({ filas: t.rows.length, primeras: t.rows.slice(0, 4) })),
      };
      try { const m = parsePlayers(html); out[k].equipos = Object.keys(m).length; out[k].ejemploEquipos = Object.keys(m).slice(0, 8); }
      catch (e) { out[k].error = e.message; }
    } catch (e) { out[k] = { url: u, error: e.message }; }
  }));
  return out;
}

function find(map, name) {
  if (!map) return null;
  const k = key(name);
  if (map[k]) return map[k];
  const keys = Object.keys(map);
  let hits = keys.filter((x) => x.startsWith(k) || k.startsWith(x));
  if (hits.length !== 1) hits = keys.filter((x) => x.includes(k) || k.includes(x));
  return hits.length === 1 ? map[hits[0]] : null;
}

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

// Los 32 equipos como los escribe TeamRankings en calendario y estadísticas
const NFL_TEAMS = ["Arizona", "Atlanta", "Baltimore", "Buffalo", "Carolina", "Chicago", "Cincinnati",
  "Cleveland", "Dallas", "Denver", "Detroit", "Green Bay", "Houston", "Indianapolis", "Jacksonville",
  "Kansas City", "LA Chargers", "LA Rams", "Las Vegas", "Miami", "Minnesota", "New England",
  "New Orleans", "NY Giants", "NY Jets", "Philadelphia", "Pittsburgh", "San Francisco", "Seattle",
  "Tampa Bay", "Tennessee", "Washington"];

// /api/nfl?part=players — jugadores de los 32 equipos, en una llamada aparte
// (así no compite con las 6 páginas de equipos por el tiempo límite de Netlify)
async function playersResponse() {
  const warnings = [];
  const res = await Promise.allSettled(PLAYER_KEYS.map((k) => getHtml(PLAYER_STATS[k], 2, 4000)));
  let players = {};
  res.forEach((r, i) => {
    const k = PLAYER_KEYS[i];
    if (r.status !== "fulfilled") { warnings.push(`jugadores ${k}: ${r.reason?.message || r.reason}`); players[k] = null; return; }
    try { players[k] = parsePlayers(r.value); } catch (e) { warnings.push(`jugadores ${k}: ${e.message}`); players[k] = null; }
  });
  const known = new Set(NFL_TEAMS.map((t) => key(t)));
  const sample = PLAYER_KEYS.map((k) => players[k]).filter(Boolean).slice(0, 1)
    .flatMap((m) => Object.values(m).slice(0, 3).map((x) => Object.values(x)[0].team));
  players = remapAllPlayers(players, known);
  const byTeam = {};
  for (const k of known) { const list = teamPlayers(players, k); if (list) byTeam[k] = list; }
  if (PLAYER_KEYS.some((k) => players[k]) && !Object.keys(byTeam).length)
    warnings.push(`Jugadores: las tablas cargaron pero ningún equipo coincidió. Ej.: ${sample.join(", ")}`);
  const ok = Object.keys(byTeam).length > 0;
  return json({ ok, updated: new Date().toISOString(), players: byTeam, warnings, error: ok ? undefined : "No se pudieron cargar los jugadores" },
    ok ? 200 : 502,
    ok ? {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=1800, stale-while-revalidate=3600",
      "Netlify-Vary": "query=part",
    } : { "Cache-Control": "no-store" });
}

export default async (req) => {
  const q = req ? new URL(req.url).searchParams : new URLSearchParams();
  if (q.get("debug") === "players")
    return json(await debugPlayers(), 200, { "Cache-Control": "no-store" });
  if (q.get("part") === "players") return playersResponse();
  const names = ["schedule", "standings", ...STAT_KEYS];
  const results = await Promise.allSettled(names.map((k) => getHtml(URLS[k])));

  const warnings = [];
  const html = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") html[names[i]] = r.value;
    else warnings.push(`${names[i]}: ${r.reason?.message || r.reason}`);
  });

  if (!html.schedule) {
    return json(
      { ok: false, error: "No se pudo leer el calendario de TeamRankings.", warnings },
      502,
      { "Cache-Control": "no-store" }
    );
  }

  const safe = (label, fn, src) => {
    if (!src) return null;
    try { return fn(src); } catch (e) { warnings.push(`${label}: ${e.message}`); return null; }
  };

  const games = safe("schedule", parseSchedule, html.schedule) || [];
  if (!games.length) warnings.push("schedule: no se encontraron partidos en el calendario");
  const standings = safe("standings", parseStandings, html.standings);
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = safe(k, parseStat, html[k]);

  const warned = new Set();
  const team = (name) => {
    const t = { name, standing: find(standings, name) };
    for (const k of STAT_KEYS) t[k] = find(stats[k], name);
    // clave con la que la página busca a sus jugadores en /api/nfl?part=players
    const kk = key(name);
    t.key = NFL_TEAMS.some((x) => key(x) === kk) ? kk : (find(Object.fromEntries(NFL_TEAMS.map((x) => [key(x), key(x)])), name) || kk);
    const loaded = { standing: standings, ...stats };
    const missing = Object.keys(loaded).filter((k) => loaded[k] && !t[k]);
    if (missing.length && !warned.has(name)) {
      warned.add(name);
      warnings.push(`${name}: sin datos en ${missing.join(", ")}`);
    }
    return t;
  };

  // Cada equipo se envía una sola vez; los partidos solo llevan el nombre
  const teams = {};
  for (const g of games) for (const n of [g.home, g.away]) if (!teams[n]) teams[n] = team(n);

  return json(
    { ok: true, updated: new Date().toISOString(), games, teams, warnings },
    200,
    {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=900, stale-while-revalidate=3600",
    }
  );
};

export const config = { path: "/api/nfl" };
