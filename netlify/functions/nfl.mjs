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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------- descarga con reintento y límite de tiempo ----------
async function getHtml(url, tries = 2, timeoutMs = 4000) {
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

export default async () => {
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
