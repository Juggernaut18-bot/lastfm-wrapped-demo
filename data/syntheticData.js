"use strict";
/**
 * Synthetic Last.fm-style listening history.
 *
 * Everything here is fictional. No real Last.fm data, credentials, or
 * personal information is used anywhere in this module or the demo.
 *
 * We generate a deterministic (seeded) corpus of fake "scrobbles" spanning
 * several years so that every tab in the UI (Day / Week / Month / Year /
 * Lifetime) has something realistic to show, plus a set of fictional
 * concerts for the Concerts tab.
 */

// ---------------------------------------------------------------------
// Deterministic PRNG (mulberry32) so the catalog + history are stable
// across server restarts on the same day, but still feel organic.
// ---------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(0xc0ffee42);
function pick(arr) {
  return arr[Math.floor(rand() * arr.length)];
}
function pickN(arr, n) {
  const copy = [...arr];
  const out = [];
  while (out.length < n && copy.length) {
    const i = Math.floor(rand() * copy.length);
    out.push(copy.splice(i, 1)[0]);
  }
  return out;
}
function randInt(min, max) {
  return Math.floor(rand() * (max - min + 1)) + min;
}

// ---------------------------------------------------------------------
// Fictional user identity
// ---------------------------------------------------------------------
const FAKE_USER = {
  name: "wavelength_archive",
  registered: { "#text": "", unixtime: String(Math.floor(new Date("2019-11-02T00:00:00Z").getTime() / 1000)) },
  url: null
};

// ---------------------------------------------------------------------
// Fictional artist / album / track catalog
// ---------------------------------------------------------------------
const CATALOG = [
  { artist: "Periphery", weight: 12, albums: ["Periphery III: Select Difficulty"], tracks: ["Marigold", "The Way the News Goes...", "Lune", "Absolomb"], image: "https://muzikercdn.com/uploads/products/3727/372797/main_188f969b.jpg" },
  { artist: "Plini", weight: 10, albums: ["Handmade Cities"], tracks: ["Electric Sunrise", "Every Piece Matters", "Selenium Forest", "Handmade Cities"], image: "https://m.media-amazon.com/images/I/A1x%2B0Li2pcL._UXNaN_FMjpg_QL85_.jpg" },
  { artist: "Dream Theater", weight: 9, albums: ["Metropolis Pt. 2: Scenes from a Memory"], tracks: ["The Dance of Eternity", "The Spirit Carries On", "Overture 1928", "Fatal Tragedy"], image: "https://wmg.jp/packages/1954/images/amcy000007087_LLL.jpg" },
  { artist: "Pink Floyd", weight: 8, albums: ["The Dark Side of the Moon"], tracks: ["Time", "Money", "Breathe", "Us and Them"], image: "https://specials-images.forbesimg.com/imageserve/640ddc5c750aeccba86bedff/960x0.jpg?fit=scale" },
  { artist: "Radiohead", weight: 8, albums: ["OK Computer"], tracks: ["Paranoid Android", "Karma Police", "No Surprises", "Airbag"], image: "https://cdn.hmv.com/r/w-1280/hmv/files/62/62018116-e48f-4711-81e7-1cc9fed95da7.jpg" },
  { artist: "Animals as Leaders", weight: 8, albums: ["Animals as Leaders"], tracks: ["CAFO", "Tempting Time", "On Impulse", "Inamorata"], image: "https://www.emp.at/dw/image/v2/BBQV_PRD/on/demandware.static/-/Sites-master-emp/default/dwa20f4a52/images/4/6/1/8/461844a.jpg?sfrm=png" },
  { artist: "TesseracT", weight: 7, albums: ["Altered State"], tracks: ["Nocturne", "Of Matter", "King", "Resist"], image: "https://cdn-s3.allmusic.com/release-covers/500/0004/544/0004544436.jpg" },
  { artist: "Meshuggah", weight: 7, albums: ["obZen"], tracks: ["Bleed", "Dancers to a Discordant System", "Lethargica", "Combustion"], image: "https://c02.purpledshub.com/uploads/sites/16/2008/01/Meshuggah-Obzen.jpg" },
  { artist: "Opeth", weight: 6, albums: ["Damnation"], tracks: ["Windowpane", "In My Time of Need", "Closure", "To Rid the Disease"], image: "https://assai.co.uk/cdn/shop/products/8718469531479_700x700.jpg?v=1493686444" },
  { artist: "King Crimson", weight: 5, albums: ["In the Court of the Crimson King"], tracks: ["21st Century Schizoid Man", "Epitaph", "I Talk to the Wind", "Moonchild"], image: "https://static.wixstatic.com/media/f4feac_e65b8cfec07745338d77a0deb8581fe0~mv2.jpg/v1/fill/w_720%2Ch_720%2Cal_c%2Clg_1%2Cq_85/f4feac_e65b8cfec07745338d77a0deb8581fe0~mv2.jpg" }
];

// Build a weighted pool so "favorite" artists show up disproportionately
// more often, like a real listening history.
const WEIGHTED_POOL = [];
for (const entry of CATALOG) {
  for (let i = 0; i < entry.weight; i++) WEIGHTED_POOL.push(entry);
}

function trackImage(entry) {
  return entry?.image || null;
}

// ---------------------------------------------------------------------
// Generate the full synthetic scrobble corpus
// ---------------------------------------------------------------------
const REGISTERED_UNIX = Number(FAKE_USER.registered.unixtime);
const NOW = Math.floor(Date.now() / 1000);

function densityForDay(dayStart) {
  // Base listening density rises gradually and spikes within the
  // "wrapped year" window (18 May 2025 -> 18 May 2026) and very recently,
  // so Day/Week/Month/Year/Lifetime all have rich, plausible data.
  const yearFrom = Date.UTC(2025, 4, 18) / 1000;
  const yearTo = Date.UTC(2026, 4, 18) / 1000;
  let base = 9;
  if (dayStart >= yearFrom && dayStart <= yearTo) base = 26;
  if (dayStart >= NOW - 30 * 86400) base = 34;
  if (dayStart >= NOW - 7 * 86400) base = 40;
  // Weekend bump
  const weekday = new Date(dayStart * 1000).getUTCDay();
  if (weekday === 0 || weekday === 6) base = Math.round(base * 1.3);
  return base;
}

function hourWeight(hour) {
  // Evenings/nights favored, quiet overnight hours, a commute bump.
  const weights = [1, 1, 1, 1, 1, 2, 3, 4, 5, 3, 3, 3, 4, 4, 4, 4, 5, 6, 8, 9, 8, 6, 4, 2];
  return weights[hour] || 1;
}

function buildScrobbles() {
  const scrobbles = [];
  let day = Math.floor(REGISTERED_UNIX / 86400) * 86400;
  const lastDay = Math.floor(NOW / 86400) * 86400;

  while (day <= lastDay) {
    const count = Math.max(0, Math.round(densityForDay(day) * (0.55 + rand() * 0.9)));
    for (let i = 0; i < count; i++) {
      const entry = pick(WEIGHTED_POOL);
      const track = pick(entry.tracks);
      const album = pick(entry.albums);
      // Weighted hour pick
      let hour = randInt(0, 23);
      if (rand() < 0.6) {
        // bias toward higher-weight hours via rejection sampling (cheap)
        for (let attempt = 0; attempt < 4; attempt++) {
          const candidate = randInt(0, 23);
          if (hourWeight(candidate) >= hourWeight(hour)) hour = candidate;
        }
      }
      const minute = randInt(0, 59);
      const second = randInt(0, 59);
      let ts = day + hour * 3600 + minute * 60 + second;
      if (ts > NOW) ts = NOW - randInt(0, 3600);
      scrobbles.push({
        artist: entry.artist,
        track,
        album,
        uts: ts,
        image: trackImage(entry)
      });
    }
    day += 86400;
  }

  scrobbles.sort((a, b) => b.uts - a.uts);
  return scrobbles;
}

const SCROBBLES = buildScrobbles();

// A little "currently scrobbling" flourish for the Recent view.
const NOW_PLAYING = (() => {
  const entry = pick(WEIGHTED_POOL);
  return {
    artist: entry.artist,
    track: pick(entry.tracks),
    album: pick(entry.albums),
    uts: null,
    image: trackImage(entry),
    now_playing: true
  };
})();

// ---------------------------------------------------------------------
// Fictional concerts (Concerts tab seed data) — entirely made up.
// ---------------------------------------------------------------------
const CONCERTS_SEED = [
  {
    id: "concert-0001",
    artist: "Glass Orchard",
    name: "Orchard in Winter Tour",
    venue: "Thistlewood Hall",
    date: "2026-02-14",
    city: "Portland, OR",
    openers: ["Driftwood Choir"],
    setlist: "Orchard in Winter\nFrostbitten Porch Light\nCider Static\nQuiet Harvest\nEncore: Mirror Horses (cover)",
    rank: 5,
    diary: "Snowed the whole walk over. The room smelled like cedar and everyone sang the bridge of 'Quiet Harvest' without being asked.",
    travel: "Train up from Eugene, stayed with a friend near Alberta Arts.",
    photo: ""
  },
  {
    id: "concert-0002",
    artist: "Nocturne Freight",
    name: "Night Shift Economy Release Show",
    venue: "The Loading Dock",
    date: "2025-09-06",
    city: "Chicago, IL",
    openers: ["Static Province", "Nine Volt Chapel"],
    setlist: "Diesel Hymn\nLoading Dock\nFreight Hours\nNight Shift Economy",
    rank: 4,
    diary: "Standing room only, lost my voice by the third song. Genuinely one of the loudest rooms I've been in.",
    travel: "Flew in for the weekend, met up with two internet friends for the first time in person.",
    photo: ""
  },
  {
    id: "concert-0003",
    artist: "Hollow Carousel",
    name: "Carnival Teeth: 10th Anniversary",
    venue: "Mirrorball Theater",
    date: "2025-05-18",
    city: "Austin, TX",
    openers: [],
    setlist: "Carnival Teeth (full album, in order)\nEncore: Ticket Stub\nFunhouse Static",
    rank: 5,
    diary: "They played the whole record front to back. Cried a little during 'Mirror Horses', no regrets.",
    travel: "Road trip with two friends, 9 hours each way, worth every mile.",
    photo: ""
  },
  {
    id: "concert-0004",
    artist: "Velvet Antenna",
    name: "Reception Tour",
    venue: "Static Room",
    date: "2024-11-22",
    city: "Seattle, WA",
    openers: ["Cassette Weather"],
    setlist: "Channel 9\nReception\nStatic Bloom\nVelvet Antenna",
    rank: 3,
    diary: "Small venue, great sound. The opener won me over more than I expected.",
    travel: "",
    photo: ""
  },
  {
    id: "concert-0005",
    artist: "Paper Lantern Riot",
    name: "Riot Season",
    venue: "Kerosene Club",
    date: "2024-07-30",
    city: "Denver, CO",
    openers: ["Felt Tip Riot", "Overcast Youth Club"],
    setlist: "Fuse Box\nKerosene Kids\nLantern Walk\nRiot Season",
    rank: 4,
    diary: "The pit for this one was unexpectedly intense for a band this mellow on record.",
    travel: "Drove up from Albuquerque with the windows down the whole way.",
    photo: ""
  },
  {
    id: "concert-0006",
    artist: "Driftwood Choir",
    name: "Low Tide Hymnal",
    venue: "Harborlight Pavilion",
    date: "2023-08-12",
    city: "Portland, ME",
    openers: [],
    setlist: "Tide Pool\nSalt Choir\nDriftwood\nLow Tide Hymnal",
    rank: 5,
    diary: "Outdoor show right on the water, sunset during the second song. Hard to beat.",
    travel: "",
    photo: ""
  },
  {
    id: "concert-0007",
    artist: "Minor Keys",
    name: "B-Side of the Moon",
    venue: "Flat Fifth Lounge",
    date: "2022-10-01",
    city: "Nashville, TN",
    openers: ["Lukewarm Radio"],
    setlist: "Suspended Chord\nMinor Keys\nFlat Fifth\nB-Side of the Moon",
    rank: 3,
    diary: "First concert back after a long break from going out. Good choice for it.",
    travel: "",
    photo: ""
  }
];

const CONCERTS_TRASH_SEED = [
  {
    id: "concert-0099",
    artist: "The Understudy",
    name: "Second String (Cancelled Rescheduled Makeup Show)",
    venue: "Cue Card Room",
    date: "2023-03-02",
    city: "Richmond, VA",
    openers: [],
    setlist: "Dress Rehearsal\nSecond String",
    rank: 2,
    diary: "Logged this twice by mistake and moved the duplicate here.",
    travel: "",
    photo: "",
    deletedAt: "2026-01-04T10:12:00.000Z"
  }
];

module.exports = {
  FAKE_USER,
  SCROBBLES,
  NOW_PLAYING,
  CONCERTS_SEED,
  CONCERTS_TRASH_SEED,
  REGISTERED_UNIX
};
