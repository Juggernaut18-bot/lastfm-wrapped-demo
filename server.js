"use strict";
/**
 * lastfm-wrapped-demo — local demo server
 * -----------------------------------------------------------------------
 * A fully self-contained, offline-friendly re-creation of the Last.fm
 * Wrapped single-page app's UI, using ONLY synthetic/fictional data.
 *
 * - No calls to Last.fm's API.
 * - No API keys, usernames, or credentials of any kind.
 * - No real personal listening data — everything comes from
 *   data/syntheticData.js, a made-up catalog of fictional artists,
 *   tracks, albums and concerts.
 *
 * This server mimics the route shapes of the original Cloudflare Worker
 * (GET /, /recent, /info, /top-artists, /top-albums, /top-tracks,
 * /history, /stats, /lifetime, /wrapped, and the /concerts* CRUD routes)
 * so the original frontend's JavaScript can run completely unmodified
 * against it.
 *
 * Run with:  node server.js   (then open http://localhost:4000)
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const {
  FAKE_USER,
  SCROBBLES,
  NOW_PLAYING,
  CONCERTS_SEED,
  CONCERTS_TRASH_SEED
} = require("./data/syntheticData");

const PORT = process.env.PORT ? Number(process.env.PORT) : 4000;
const PUBLIC_DIR = path.join(__dirname, "public");

// In-memory "database" for concerts, seeded with fictional entries.
// Mirrors the shape of the original's D1-backed /concerts* routes.
let concerts = CONCERTS_SEED.map((c) => ({ ...c }));
let concertsTrash = CONCERTS_TRASH_SEED.map((c) => ({ ...c }));

// -------------------------------------------------------------------
// Small helpers ported from the original worker, operating on the
// synthetic scrobble corpus instead of the real Last.fm API.
// -------------------------------------------------------------------
function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function parseTimestamp(value) {
  if (!value) return null;
  const timestamp = Number(value);
  if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
  return timestamp;
}

function normalizePeriod(period) {
  const allowed = ["7day", "1month", "3month", "6month", "12month", "overall"];
  return allowed.includes(period) ? period : "12month";
}

function indiaMidnightTimestamp(year, month, day) {
  const utc = Date.UTC(year, month - 1, day, 0, 0, 0);
  return Math.floor((utc - 5.5 * 60 * 60 * 1000) / 1000);
}

function getPeriodRange(period) {
  const now = Math.floor(Date.now() / 1000);
  if (period === "day") return { from: now - 24 * 60 * 60, to: now };
  if (period === "week") return { from: now - 7 * 24 * 60 * 60, to: now };
  if (period === "month") return { from: now - 30 * 24 * 60 * 60, to: now };
  if (period === "year") {
    return { from: indiaMidnightTimestamp(2025, 5, 18), to: indiaMidnightTimestamp(2026, 5, 18) };
  }
  return { from: now - 365 * 24 * 60 * 60, to: now };
}

function getStatsPeriodLabel(period, range) {
  if (period === "day") return "Last 24 hours";
  if (period === "week") return "Last 7 days";
  if (period === "month") return "Last 30 days";
  if (period === "year") return "18 May 2025 → 18 May 2026";
  if (period === "custom") return "Custom period";
  return `${range.from} → ${range.to}`;
}

function lastfmPeriodToSeconds(period) {
  return {
    "7day": 7 * 86400,
    "1month": 30 * 86400,
    "3month": 90 * 86400,
    "6month": 180 * 86400,
    "12month": 365 * 86400
  }[period] || null;
}

function scrobblesInRange(from, to) {
  // SCROBBLES is sorted newest-first; linear scan is fine at this scale.
  return SCROBBLES.filter((s) => s.uts >= from && s.uts <= to);
}

function scrobblesForLastfmPeriod(period) {
  if (period === "overall") return SCROBBLES.slice();
  const now = Math.floor(Date.now() / 1000);
  const span = lastfmPeriodToSeconds(period);
  return scrobblesInRange(now - span, now);
}

function fmtDate(uts) {
  const d = new Date(uts * 1000);
  return d.toUTCString().replace(" GMT", "");
}

function formatTrack(s) {
  return {
    artist: s.artist,
    track: s.track,
    album: s.album || "",
    timestamp: s.uts,
    date: s.uts ? fmtDate(s.uts) : null,
    now_playing: !!s.now_playing,
    url: null,
    image: s.image || null
  };
}

function topArtistsFrom(list, limit) {
  const m = new Map();
  for (const s of list) {
    const row = m.get(s.artist) || { artist: s.artist, playcount: 0, image: s.image || null };
    row.playcount++;
    m.set(s.artist, row);
  }
  return [...m.values()]
    .sort((a, b) => b.playcount - a.playcount || a.artist.localeCompare(b.artist))
    .slice(0, limit)
    .map((row, i) => ({ rank: i + 1, artist: row.artist, playcount: row.playcount, url: null, image: row.image }));
}

function topAlbumsFrom(list, limit) {
  const m = new Map();
  for (const s of list) {
    if (!s.album) continue;
    const key = `${s.artist}|||${s.album}`;
    const row = m.get(key) || { artist: s.artist, album: s.album, playcount: 0, image: s.image || null };
    row.playcount++;
    m.set(key, row);
  }
  return [...m.values()]
    .sort((a, b) => b.playcount - a.playcount || a.album.localeCompare(b.album))
    .slice(0, limit)
    .map((row, i) => ({ rank: i + 1, artist: row.artist, album: row.album, playcount: row.playcount, url: null, image: row.image }));
}

function topTracksFrom(list, limit) {
  const m = new Map();
  for (const s of list) {
    const key = `${s.artist}|||${s.track}`;
    const row = m.get(key) || { artist: s.artist, track: s.track, album: s.album || "", playcount: 0, image: s.image || null };
    row.playcount++;
    m.set(key, row);
  }
  return [...m.values()]
    .sort((a, b) => b.playcount - a.playcount || a.track.localeCompare(b.track))
    .slice(0, limit)
    .map((row, i) => ({ rank: i + 1, artist: row.artist, track: row.track, album: row.album, playcount: row.playcount, url: null, image: row.image }));
}

// Synthetic "duration sync" estimate — mirrors the shape the original
// attaches from its D1-backed duration subsystem, but computed from an
// assumed average track length instead of real per-track durations.
const AVG_TRACK_SECONDS = 214;
function attachListeningEstimate(result, totalScrobbles) {
  const covered = Math.round(totalScrobbles * 0.94);
  const seconds = covered * AVG_TRACK_SECONDS;
  return {
    ...result,
    estimated_listening_seconds: seconds,
    estimated_listening_minutes: Math.floor(seconds / 60),
    duration_covered_scrobbles: covered,
    duration_total_scrobbles: totalScrobbles,
    duration_coverage_percent: totalScrobbles > 0 ? Number(((covered / totalScrobbles) * 100).toFixed(1)) : 0,
    duration_estimate_generated_at: new Date().toISOString()
  };
}

function buildStats(from, to) {
  const list = scrobblesInRange(from, to);
  const monthly = {};
  const weekdays = {};
  const hourly = {};
  for (const s of list) {
    const d = new Date(s.uts * 1000);
    const month = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    const weekday = d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
    const hour = d.getUTCHours();
    monthly[month] = (monthly[month] || 0) + 1;
    weekdays[weekday] = (weekdays[weekday] || 0) + 1;
    hourly[String(hour)] = (hourly[String(hour)] || 0) + 1;
  }
  const uniqueArtists = new Set(list.map((s) => s.artist)).size;
  const uniqueAlbums = new Set(list.filter((s) => s.album).map((s) => `${s.artist}|||${s.album}`)).size;
  const uniqueTracks = new Set(list.map((s) => `${s.artist}|||${s.track}`)).size;

  const result = {
    user: FAKE_USER.name,
    total_scrobbles: list.length,
    analyzed_scrobbles: list.length,
    unique_artists: uniqueArtists,
    unique_albums: uniqueAlbums,
    unique_tracks: uniqueTracks,
    top_artists: topArtistsFrom(list, 10),
    top_albums: topAlbumsFrom(list, 10),
    top_tracks: topTracksFrom(list, 10),
    listening_by_month: monthly,
    listening_by_weekday: weekdays,
    listening_by_hour: hourly
  };
  return attachListeningEstimate(result, list.length);
}

function buildLifetimeStats() {
  const list = SCROBBLES;
  const uniqueArtists = new Set(list.map((s) => s.artist)).size;
  const uniqueAlbums = new Set(list.filter((s) => s.album).map((s) => `${s.artist}|||${s.album}`)).size;
  const uniqueTracks = new Set(list.map((s) => `${s.artist}|||${s.track}`)).size;
  const total = list.length;
  const result = {
    user: FAKE_USER.name,
    period: "lifetime",
    period_label: "ALL TIME",
    total_scrobbles: total,
    analyzed_scrobbles: total,
    unique_artists: uniqueArtists,
    unique_albums: uniqueAlbums,
    unique_tracks: uniqueTracks,
    top_artists: topArtistsFrom(list, 10),
    top_albums: topAlbumsFrom(list, 10),
    top_tracks: topTracksFrom(list, 10)
  };
  return attachListeningEstimate(result, total);
}

// -------------------------------------------------------------------
// Concerts helpers (mirror normalizeConcertPayload / parseConcertOpeners)
// -------------------------------------------------------------------
function normalizeConcertPayload(payload, existingId) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Concert payload must be a JSON object.");
  }
  const artist = String(payload.artist || "").trim();
  if (!artist) throw new Error("Artist is required.");
  const id = String(existingId || payload.id || crypto.randomUUID()).trim();
  const openers = Array.isArray(payload.openers)
    ? payload.openers.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const rank = payload.rank == null || payload.rank === "" ? null : Number(payload.rank);
  return {
    id,
    artist,
    name: String(payload.name || "").trim(),
    venue: String(payload.venue || "").trim(),
    date: String(payload.date || "").trim(),
    city: String(payload.city || "").trim(),
    openers,
    setlist: String(payload.setlist || "").trim(),
    rank: Number.isFinite(rank) ? rank : null,
    diary: String(payload.diary || "").trim(),
    travel: String(payload.travel || "").trim(),
    photo: String(payload.photo || "")
  };
}

// -------------------------------------------------------------------
// HTTP plumbing
// -------------------------------------------------------------------
function json(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    ...extraHeaders
  });
  res.end(body);
}

function notFound(res, message = "Not found.") {
  json(res, { error: message }, 404);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

function serveStatic(res, filePath) {
  fs.readFile(filePath, (err, content) => {
    if (err) return notFound(res);
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    });
    return res.end();
  }

  try {
    if (pathname === "/" && req.method === "GET") {
      return serveStatic(res, path.join(PUBLIC_DIR, "index.html"));
    }

    if (pathname === "/recent" && req.method === "GET") {
      const limit = clamp(parseInt(url.searchParams.get("limit") || "20", 10), 1, 200);
      const tracks = [NOW_PLAYING, ...SCROBBLES.slice(0, limit - 1)].map(formatTrack);
      return json(res, {
        user: FAKE_USER.name,
        total_pages: 1,
        total_scrobbles: SCROBBLES.length,
        tracks
      });
    }

    if (pathname === "/info" && req.method === "GET") {
      return json(res, {
        user: FAKE_USER.name,
        playcount: SCROBBLES.length,
        registered: FAKE_USER.registered.unixtime,
        url: FAKE_USER.url
      });
    }

    if (pathname === "/top-artists" && req.method === "GET") {
      const period = normalizePeriod(url.searchParams.get("period") || "12month");
      const limit = clamp(parseInt(url.searchParams.get("limit") || "10", 10), 1, 50);
      const list = scrobblesForLastfmPeriod(period);
      return json(res, { user: FAKE_USER.name, period, artists: topArtistsFrom(list, limit) });
    }

    if (pathname === "/top-albums" && req.method === "GET") {
      const period = normalizePeriod(url.searchParams.get("period") || "12month");
      const limit = clamp(parseInt(url.searchParams.get("limit") || "10", 10), 1, 100);
      const list = scrobblesForLastfmPeriod(period);
      return json(res, { user: FAKE_USER.name, period, albums: topAlbumsFrom(list, limit) });
    }

    if (pathname === "/top-tracks" && req.method === "GET") {
      const period = normalizePeriod(url.searchParams.get("period") || "12month");
      const limit = clamp(parseInt(url.searchParams.get("limit") || "10", 10), 1, 50);
      const list = scrobblesForLastfmPeriod(period);
      return json(res, { user: FAKE_USER.name, period, tracks: topTracksFrom(list, limit) });
    }

    if (pathname === "/history" && req.method === "GET") {
      const from = parseTimestamp(url.searchParams.get("from"));
      const to = parseTimestamp(url.searchParams.get("to"));
      if (!from || !to || to <= from) {
        return json(res, { error: "Valid 'from' and 'to' Unix timestamps are required." }, 400);
      }
      const page = clamp(parseInt(url.searchParams.get("page") || "1", 10), 1, 10000);
      const limit = clamp(parseInt(url.searchParams.get("limit") || "200", 10), 1, 200);
      const list = scrobblesInRange(from, to); // already newest-first
      const start = (page - 1) * limit;
      const pageItems = list.slice(start, start + limit);
      return json(res, {
        user: FAKE_USER.name,
        page,
        per_page: limit,
        total_pages: Math.max(1, Math.ceil(list.length / limit)),
        total_scrobbles: list.length,
        tracks: pageItems.map(formatTrack)
      });
    }

    if (pathname === "/stats" && req.method === "GET") {
      const requestedPeriod = url.searchParams.get("period") || null;
      const customFrom = parseTimestamp(url.searchParams.get("from"));
      const customTo = parseTimestamp(url.searchParams.get("to"));
      let period = requestedPeriod;
      if (!customFrom && !customTo) {
        if (!["day", "week", "month", "year"].includes(period)) period = "year";
      }
      let range;
      if (customFrom && customTo && customTo > customFrom) {
        range = { from: customFrom, to: customTo };
        period = "custom";
      } else {
        range = getPeriodRange(period);
      }
      const result = buildStats(range.from, range.to);
      result.period = period;
      result.period_label = getStatsPeriodLabel(period, range);
      result.range = { from: range.from, to: range.to };
      return json(res, result, 200, { "X-Stats-Cache": "MISS" });
    }

    if (pathname === "/lifetime" && req.method === "GET") {
      return json(res, buildLifetimeStats(), 200, { "X-Lifetime-Cache": "MISS" });
    }

    if (pathname === "/wrapped" && req.method === "GET") {
      const from = parseTimestamp(url.searchParams.get("from"));
      const to = parseTimestamp(url.searchParams.get("to"));
      if (!from || !to || to <= from) {
        return json(res, { error: "Valid 'from' and 'to' Unix timestamps are required." }, 400);
      }
      const result = buildStats(from, to);
      result.range = { from, to };
      return json(res, result, 200, { "X-Wrapped-Cache": "MISS" });
    }

    // ---- Concerts ----
    if (pathname === "/concerts/trash" && req.method === "GET") {
      return json(res, concertsTrash);
    }

    if (pathname === "/concerts") {
      if (req.method === "GET") {
        const sorted = [...concerts].sort((a, b) => {
          if (a.date !== b.date) return a.date < b.date ? 1 : -1;
          return 0;
        });
        return json(res, sorted);
      }
      if (req.method === "POST") {
        const payload = await readBody(req);
        const concert = normalizeConcertPayload(payload);
        concert.created_at = new Date().toISOString();
        concert.updated_at = concert.created_at;
        concerts.push(concert);
        return json(res, concert, 201);
      }
      return json(res, { error: "Method not allowed." }, 405, { Allow: "GET, POST, OPTIONS" });
    }

    const restoreMatch = pathname.match(/^\/concerts\/([^/]+)\/restore$/);
    if (restoreMatch && req.method === "POST") {
      const id = decodeURIComponent(restoreMatch[1]);
      const idx = concertsTrash.findIndex((c) => c.id === id);
      if (idx === -1) return json(res, { error: "Deleted concert not found." }, 404);
      const [restored] = concertsTrash.splice(idx, 1);
      delete restored.deletedAt;
      restored.updated_at = new Date().toISOString();
      concerts.push(restored);
      return json(res, restored);
    }

    const itemMatch = pathname.match(/^\/concerts\/([^/]+)$/);
    if (itemMatch) {
      const id = decodeURIComponent(itemMatch[1]);
      if (req.method === "PUT") {
        const payload = await readBody(req);
        const idx = concerts.findIndex((c) => c.id === id);
        if (idx === -1) return json(res, { error: "Concert not found." }, 404);
        const updated = normalizeConcertPayload({ ...payload, id }, id);
        updated.created_at = concerts[idx].created_at || new Date().toISOString();
        updated.updated_at = new Date().toISOString();
        concerts[idx] = updated;
        return json(res, updated);
      }
      if (req.method === "DELETE") {
        const permanent = url.searchParams.get("permanent") === "1";
        const idx = concerts.findIndex((c) => c.id === id);
        if (idx === -1) return json(res, { error: "Concert not found." }, 404);
        const [removed] = concerts.splice(idx, 1);
        if (!permanent) {
          removed.deletedAt = new Date().toISOString();
          concertsTrash.unshift(removed);
        }
        res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
        return res.end();
      }
      return json(res, { error: "Method not allowed." }, 405, { Allow: "PUT, DELETE, OPTIONS" });
    }

    // Fallback to static files (none expected beyond index.html, but
    // harmless if the page references a relative asset in the future).
    const candidate = path.join(PUBLIC_DIR, pathname);
    if (candidate.startsWith(PUBLIC_DIR) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return serveStatic(res, candidate);
    }

    return notFound(res, "Unknown route.");
  } catch (err) {
    return json(res, { error: err.message || "Internal error." }, 500);
  }
});

server.listen(PORT, () => {
  console.log(`lastfm-wrapped-demo running at http://localhost:${PORT}`);
  console.log(`Synthetic scrobbles loaded: ${SCROBBLES.length}`);
});
