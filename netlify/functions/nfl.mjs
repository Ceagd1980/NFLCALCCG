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
      // Partido jugado: TeamRankings pone el marcador junto a cada equipo ("Miami 24 @ Georgia Tech 21")
      // o en otra celda ("24-21", "W 24-21", "Final 24-21").
      const sc = (raw) => { const m = /\s(\d{1,3})\s*$/.exec(raw.replace(/\(\d+-\d+(-\d+)?\)/g, "").trim()); return m ? +m[1] : null; };
      let awayScore = sc(mm[1]), homeScore = sc(mm[3]);
      let result = "";
      if (awayScore == null || homeScore == null) {
        awayScore = homeScore = null;
        const cell = r.slice(1).find((c) => /\b\d{1,3}\s*[-–]\s*\d{1,3}\b/.test(c) && !/\d{1,2}:\d{2}/.test(c));
        if (cell) result = cell.trim();
      }
      const time = r[iTime] || "";
      games.push({
        date: iso,
        dateLabel,
        away: cleanTeam(mm[1]),
        home: cleanTeam(mm[3]),
        neutral: /^vs/i.test(mm[2]),
        time: /final/i.test(time) || /^\D*\d{1,3}\s*[-–]\s*\d{1,3}\D*$/.test(time) ? "" : time,
        location: r[iLoc] || "",
        awayScore, homeScore,
        result: awayScore != null ? "" : result || (/final/i.test(time) ? time : ""),
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
    // Récord en casa y fuera (si la tabla trae esas columnas)
    const iHome = idx(/^home$|^home\s*w-l/i), iRoad = idx(/^road$|^away$|^road\s*w-l|^away\s*w-l/i);
    const rec = (c) => { const m = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(String(c || "").trim()); return m ? { w: +m[1], l: +m[2], t: +(m[3] || 0), gp: +m[1] + +m[2] + +(m[3] || 0) } : null; };

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
        ...(() => {
          // récord general = el de más partidos de la fila (así no se toma el de casa/fuera/conferencia)
          const best = r.map(rec).filter(Boolean).sort((a, b) => b.gp - a.gp)[0];
          return best ? { w: best.w, l: best.l, t: best.t, gp: best.gp } : {};
        })(),
        home: iHome >= 0 ? rec(r[iHome]) : null,
        road: iRoad >= 0 ? rec(r[iRoad]) : null,
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

// Lista de semanas del selector "Week:" de TeamRankings (<option value="1284">Week 4 ...</option>)
function parseWeeks(html, requested) {
  if (!html) return [];
  const sel = /<select[^>]*(?:week)[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  const src = sel ? sel[1] : html;
  const out = [];
  for (const m of src.matchAll(/<option([^>]*)value="(\d{2,6})"([^>]*)>([\s\S]*?)<\/option>/gi)) {
    const attrs = m[1] + m[3];
    out.push({ id: m[2], label: decode(m[4]), selected: requested ? m[2] === requested : /selected/i.test(attrs) });
  }
  return out;
}

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

// ---------- fuerza relativa (últimos 5 resultados) y marcadores de días pasados ----------
// Se leen de la página de cada equipo en TeamRankings (/nfl/team/<slug>).
const FR_SPORT = "nfl";
const TEAM_SLUGS = Object.fromEntries([["Arizona", "arizona-cardinals"], ["Atlanta", "atlanta-falcons"], ["Baltimore", "baltimore-ravens"], ["Buffalo", "buffalo-bills"], ["Carolina", "carolina-panthers"], ["Chicago", "chicago-bears"], ["Cincinnati", "cincinnati-bengals"], ["Cleveland", "cleveland-browns"], ["Dallas", "dallas-cowboys"], ["Denver", "denver-broncos"], ["Detroit", "detroit-lions"], ["Green Bay", "green-bay-packers"], ["Houston", "houston-texans"], ["Indianapolis", "indianapolis-colts"], ["Jacksonville", "jacksonville-jaguars"], ["Kansas City", "kansas-city-chiefs"], ["LA Chargers", "los-angeles-chargers"], ["LA Rams", "los-angeles-rams"], ["Las Vegas", "las-vegas-raiders"], ["Miami", "miami-dolphins"], ["Minnesota", "minnesota-vikings"], ["New England", "new-england-patriots"], ["New Orleans", "new-orleans-saints"], ["NY Giants", "new-york-giants"], ["NY Jets", "new-york-jets"], ["Philadelphia", "philadelphia-eagles"], ["Pittsburgh", "pittsburgh-steelers"], ["San Francisco", "san-francisco-49ers"], ["Seattle", "seattle-seahawks"], ["Tampa Bay", "tampa-bay-buccaneers"], ["Tennessee", "tennessee-titans"], ["Washington", "washington-commanders"]].map(([n, s]) => [key(n), s]));
function teamSlugs(html) {
  const out = {};
  const re = new RegExp(`<a[^>]*href="[^"]*/${FR_SPORT}/team/([a-z0-9-]+)[^"]*"[^>]*>([\\s\\S]*?)</a>`, "gi");
  let m;
  while ((m = re.exec(html || ""))) { const k = key(cleanTeam(decode(m[2]))); if (k && !out[k]) out[k] = m[1]; }
  return out;
}
const FR_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// "10/04", "10/04/2026", "Oct 4", "2026-10-04" → "2026-10-04" (si no trae año, el más cercano a la fecha consultada)
function frIso(txt, refIso) {
  const t = String(txt || "").trim();
  let y = null, mo = null, d = null, m;
  if ((m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(t))) { mo = +m[1]; d = +m[2]; if (m[3]) y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; }
  else if ((m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/.exec(t)) && FR_MONTHS[m[1].toLowerCase()]) { mo = FR_MONTHS[m[1].toLowerCase()]; d = +m[2]; }
  if (!mo || !d) return null;
  if (!y) { const [ry, rm] = refIso.split("-").map(Number); y = mo - rm > 6 ? ry - 1 : rm - mo > 6 ? ry + 1 : ry; }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
// Resultados de la página del equipo: columna "Result" ("W 88-80", "L 3-5", "T 20-20") y "Date"
function parseForm(html, beforeIso) {
  const games = [];
  let order = 0;
  for (const t of parseTables(html)) {
    const hi = t.rows.findIndex((r) => r.some((c) => /^(result|w\/l)$/i.test(c.trim())));
    if (hi < 0) continue;
    const hdr = t.rows[hi].map((c) => c.trim());
    const iD = hdr.findIndex((c) => /^date$/i.test(c));
    const iR = hdr.findIndex((c) => /^result$/i.test(c));
    const iWL = hdr.findIndex((c) => /^w\/l$/i.test(c));
    for (const r of t.rows.slice(hi + 1)) {
      let wl = null;
      const rc = iR >= 0 ? (r[iR] || "").trim() : "";
      const m = /^([WLT])\b\s*(\d+)\s*[-–]\s*(\d+)/i.exec(rc);
      if (m) wl = m[1].toUpperCase();
      else if (iWL >= 0 && /^[WLT]$/i.test((r[iWL] || "").trim())) wl = r[iWL].trim().toUpperCase();
      if (!wl) continue;
      games.push({ date: iD >= 0 ? frIso(r[iD], beforeIso) : null, wl, order: order++, score: m ? `${m[2]}-${m[3]}` : "" });
    }
  }
  const dated = games.length > 0 && games.every((g) => g.date);
  const list = dated ? games.filter((g) => g.date < beforeIso).sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order) : games;
  const last = list.slice(-5);
  const on = dated ? games.filter((g) => g.date === beforeIso).sort((a, b) => a.order - b.order).map((g) => ({ wl: g.wl, score: g.score })) : [];
  if (!last.length && !on.length) return null;
  return {
    fr: last.length ? last.reduce((n, g) => n + (g.wl === "W" ? 1 : g.wl === "L" ? -1 : 0), 0) : null,
    last: last.map((g) => ({ wl: g.wl, date: g.date, score: g.score })), on,
  };
}
async function frFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const html = await r.text();
    if (!/<table/i.test(html)) throw new Error("la página no trae tablas");
    return html;
  } catch (e) {
    throw e.name === "AbortError" ? new Error("tiempo de espera agotado") : e;
  } finally { clearTimeout(timer); }
}
function ecToday() { return new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10); }
function slugFor(k, slugs) {
  if (slugs[k]) return slugs[k];
  if (TEAM_SLUGS[k]) return TEAM_SLUGS[k];
  const hits = Object.keys(TEAM_SLUGS).filter((x) => x.startsWith(k) || k.startsWith(x));
  return hits.length === 1 ? TEAM_SLUGS[hits[0]] : null;
}
// Lista de equipos de TeamRankings ("Arizona Diamondbacks | Rankings, Stats"): nombre completo → dirección real
const REAL_SLUGS = {};
function realSlug(guess, html) {
  if (!/team\s*links/i.test(html)) return null;
  if (!Object.keys(REAL_SLUGS).length) {
    const re = new RegExp(`/${FR_SPORT}/team/([a-z0-9-]+)`, "i");
    for (const row of html.match(/<tr[\s\S]*?<\/tr>/gi) || []) {
      const cell = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/i.exec(row);
      const m = re.exec(row);
      if (cell && m) { const n = decode(cell[1]).toLowerCase().replace(/[^a-z0-9]/g, ""); if (n && !REAL_SLUGS[n]) REAL_SLUGS[n] = m[1]; }
    }
  }
  const g = guess.replace(/[^a-z0-9]/g, "");
  if (REAL_SLUGS[g]) return REAL_SLUGS[g];
  const hits = Object.keys(REAL_SLUGS).filter((n) => n.endsWith(g.slice(-6)) && (n.includes(g.slice(0, 4)) || g.includes(n.slice(0, 4))));
  return hits.length === 1 ? REAL_SLUGS[hits[0]] : null;
}
// entries: [[clave, fecha de referencia]]; lee hasta 10 páginas a la vez sin pasarse del tiempo de Netlify
async function loadForms(scheduleHtml, entries, T0, budgetMs = 9000) {
  const slugs = teamSlugs(scheduleHtml), out = {}, errs = [];
  const queue = [...new Map(entries).entries()];
  let skipped = 0;
  const worker = async () => {
    while (queue.length) {
      const [k, ref] = queue.shift();
      const left = budgetMs - (Date.now() - T0) - 250;
      if (left < 1000) { skipped++; continue; }
      const slug = slugFor(k, slugs);
      if (!slug) { errs.push(`${k}: sin enlace de equipo`); continue; }
      try {
        let html = await frFetch(`https://www.teamrankings.com/${FR_SPORT}/team/${slug}`, Math.min(3500, left));
        out[k] = parseForm(html, ref);
        // Dirección equivocada: TeamRankings muestra la lista de equipos; se busca ahí la dirección real
        if (!out[k]) {
          const real = realSlug(slug, html);
          const left2 = budgetMs - (Date.now() - T0) - 250;
          if (real && real !== slug && left2 >= 1000) { html = await frFetch(`https://www.teamrankings.com/${FR_SPORT}/team/${real}`, Math.min(3500, left2)); out[k] = parseForm(html, ref); }
          if (!out[k]) errs.push(`${slug}: sin resultados${real && real !== slug ? ` (probé ${real})` : ""}`);
        }
      }
      catch (e) { errs.push(`${slug}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  if (skipped) errs.push(`${skipped} equipo(s) sin leer por tiempo; pulsa Actualizar`);
  return { out, errs };
}
// Completa el marcador de los partidos jugados que el calendario no trae (W/L del equipo + puntos)
function fillScores(games, forms) {
  const used = {};
  for (const g of games) {
    if (g.homeScore != null && g.awayScore != null) continue;
    const kh = key(g.home), ka = key(g.away);
    const ih = used[kh] || 0, ia = used[ka] || 0;
    const fh = forms[kh]?.on?.[ih], fa = forms[ka]?.on?.[ia];
    used[kh] = ih + 1; used[ka] = ia + 1;
    const src = fh || (fa && { wl: fa.wl === "W" ? "L" : fa.wl === "L" ? "W" : "T", score: fa.score });
    const m = src && /(\d+)-(\d+)/.exec(src.score || "");
    if (!m) continue;
    const hi = Math.max(+m[1], +m[2]), lo = Math.min(+m[1], +m[2]);
    if (src.wl === "T") { if (hi !== lo) continue; g.homeScore = g.awayScore = hi; }
    else if (hi === lo) continue;
    else [g.homeScore, g.awayScore] = src.wl === "W" ? [hi, lo] : [lo, hi];
    g.result = "";
  }
}
async function debugTeam(slug) {
  const r = await fetch(`https://www.teamrankings.com/${FR_SPORT}/team/${slug}`, { headers: HEADERS });
  const html = await r.text();
  const tables = parseTables(html);
  const form = parseForm(html, ecToday()), real = form ? null : realSlug(slug, html);
  if (real && real !== slug) return { pedido: slug, real, ...(await debugTeam(real)) };
  return { status: r.status, bytes: html.length, tables: tables.map((t) => ({ filas: t.rows.length, primeras: t.rows.slice(0, 4) })).slice(0, 6), form: parseForm(html, ecToday()) };
}

// Todos los resultados de la temporada de un equipo (la página calcula la FR para cada fecha)
function parseResults(html, refIso) {
  const games = [];
  for (const t of parseTables(html)) {
    const hi = t.rows.findIndex((r) => r.some((c) => /^result$/i.test(c.trim())));
    if (hi < 0) continue;
    const hdr = t.rows[hi].map((c) => c.trim());
    const iD = hdr.findIndex((c) => /^date$/i.test(c)), iR = hdr.findIndex((c) => /^result$/i.test(c));
    if (iD < 0) continue;
    for (const r of t.rows.slice(hi + 1)) {
      const m = /^([WLT])\b\s*(\d+)\s*[-–]\s*(\d+)/i.exec((r[iR] || "").trim());
      const date = frIso(r[iD], refIso);
      if (m && date) games.push({ date, wl: m[1].toUpperCase(), score: `${m[2]}-${m[3]}` });
    }
  }
  return games.sort((a, b) => a.date.localeCompare(b.date));
}
// /api/nfl?part=form — resultados de los 32 equipos (fuerza relativa), en una llamada aparte
async function formResponse(half) {
  const T0 = Date.now(), ref = ecToday();
  let all = [...new Set(NFL_TEAMS.map(key))];
  if (half === "0" || half === "1") all = all.filter((_, i) => i % 2 === +half); // 16 equipos por llamada
  const queue = all, teams = {}, errs = [];
  // Direcciones reales: una dirección inexistente devuelve la lista de equipos de TeamRankings
  if (!Object.keys(REAL_SLUGS).length) {
    try { realSlug("x", await frFetch("https://www.teamrankings.com/nfl/team/lista-de-equipos", 3000)); } catch {}
  }
  const worker = async () => {
    while (queue.length) {
      const k = queue.shift();
      const left = 9000 - (Date.now() - T0) - 250;
      if (left < 1000) { errs.push(`${k}: sin tiempo`); continue; }
      const guess = slugFor(k, {});
      const slug = guess && (REAL_SLUGS[guess.replace(/[^a-z0-9]/g, "")] || guess);
      if (!slug) { errs.push(`${k}: sin enlace`); continue; }
      try {
        let html = await frFetch(`https://www.teamrankings.com/nfl/team/${slug}`, Math.min(3500, left));
        teams[k] = parseResults(html, ref);
        if (!teams[k].length) {
          const real = realSlug(slug, html);
          const left2 = 9000 - (Date.now() - T0) - 250;
          if (real && real !== slug && left2 >= 1000) teams[k] = parseResults(await frFetch(`https://www.teamrankings.com/nfl/team/${real}`, Math.min(3500, left2)), ref);
          if (!teams[k].length) { delete teams[k]; errs.push(`${slug}: sin resultados${real && real !== slug ? ` (probé ${real})` : ""}`); }
        }
      }
      catch (e) { errs.push(`${slug}: ${e.message}`); }
    }
  };
  await Promise.all(Array.from({ length: 10 }, worker));
  const ok = Object.keys(teams).length > 0;
  return json({ ok, updated: new Date().toISOString(), teams, warnings: errs.length ? [`Fuerza relativa: ${errs.join(" · ")}`] : [] },
    ok ? 200 : 502,
    ok && !errs.length ? {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=1800, stale-while-revalidate=3600",
      "Netlify-Vary": "query=part|half",
    } : { "Cache-Control": "no-store" });
}

export default async (req) => {
  const q = req ? new URL(req.url).searchParams : new URLSearchParams();
  if (q.get("debug") === "players")
    return json(await debugPlayers(), 200, { "Cache-Control": "no-store" });
  if (q.get("part") === "players") return playersResponse();
  if (q.get("part") === "form") return formResponse(q.get("half"));
  if (q.get("debug") === "team")
    return json(await debugTeam(String(q.get("slug") || "kansas-city-chiefs").replace(/[^a-z0-9-]/g, "")), 200, { "Cache-Control": "no-store" });
  // ?week=NNNN → semana concreta del calendario de TeamRankings (pasadas o futuras)
  const weekParam = q.get("week");
  const week = weekParam && /^\d{1,6}$/.test(weekParam) ? weekParam : null;
  const names = ["schedule", "standings", ...STAT_KEYS];
  const urlOf = (k) => (k === "schedule" && week ? `${URLS.schedule}?week=${week}` : URLS[k]);
  const results = await Promise.allSettled(names.map((k) => getHtml(urlOf(k))));

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
    { ok: true, updated: new Date().toISOString(), games, teams, warnings, weeks: parseWeeks(html.schedule, week), week },
    200,
    {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=900, stale-while-revalidate=3600",
      "Netlify-Vary": "query=week",
    }
  );
};

export const config = { path: "/api/nfl" };
