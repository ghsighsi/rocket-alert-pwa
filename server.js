const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const https = require("https");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const PORT = process.env.PORT || 3088;
const DEFAULT_CITY = process.env.DEFAULT_CITY || "";
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL, 10) || 2000;

// ── Keep-Alive agent למניעת handshake חוזר בכל בקשה ──
const orefAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 2,
  keepAliveMsecs: 5000,
});

// ── מאגר ערים — נטען מגיטהאב בעלייה, fallback למאגר מקומי ──
let CITY_COORDS = {};

const FALLBACK_CITIES = {
  "תל אביב - יפו": [32.0853, 34.7818, 5], "חיפה": [32.794, 34.9896, 5],
  "ירושלים": [31.7683, 35.2137, 5], "באר שבע": [31.253, 34.7915, 5],
  "אשדוד": [31.8, 34.65, 5], "אשקלון": [31.6688, 34.5743, 5],
  "נתניה": [32.3215, 34.8532, 5], "רמת גן": [32.068, 34.8248, 5],
  "פתח תקווה": [32.0841, 34.8878, 5], "חולון": [32.0117, 34.7748, 5],
  "ראשון לציון": [31.973, 34.7925, 5], "מודיעין - מכבים רעות": [31.8969, 35.0104, 5],
  "הרצליה": [32.1629, 34.8441, 5], "כפר סבא": [32.1751, 34.9066, 5],
  "רעננה": [32.1836, 34.8708, 5], "בני ברק": [32.0834, 34.834, 5],
  "גבעתיים": [32.0718, 34.811, 5], "בת ים": [32.0167, 34.75, 5],
  "לוד": [31.9514, 34.8882, 5], "רמלה": [31.9275, 34.8625, 5],
  "שדרות": [31.5262, 34.595, 3], "נתיבות": [31.4204, 34.5888, 3],
  "אופקים": [31.3157, 34.62, 3], "קריית שמונה": [33.2082, 35.5704, 3],
  "נהריה": [33.0048, 35.0963, 3], "עכו": [32.928, 35.0764, 3],
  "צפת": [32.9658, 35.4983, 3], "טבריה": [32.7922, 35.5312, 3],
  "אילת": [29.5577, 34.9519, 5], "דימונה": [31.0667, 35.0333, 5],
};

function loadCitiesFromGithub() {
  const url = "https://raw.githubusercontent.com/eladnava/pikud-haoref-api/master/cities.json";
  console.log("[DB] Downloading cities database from GitHub...");

  https.get(url, (res) => {
    let data = "";
    res.on("data", (chunk) => (data += chunk));
    res.on("end", () => {
      try {
        const arr = JSON.parse(data);
        const loaded = {};
        arr.forEach((city) => {
          if (city.name && city.lat && city.lng) {
            loaded[city.name] = [parseFloat(city.lat), parseFloat(city.lng), 5];
          }
        });
        if (Object.keys(loaded).length > 100) {
          CITY_COORDS = loaded;
          console.log(`[DB] Loaded ${Object.keys(CITY_COORDS).length} cities from GitHub`);
        } else {
          console.warn("[DB] GitHub data too small, using fallback");
          CITY_COORDS = { ...FALLBACK_CITIES };
        }
      } catch (e) {
        console.error("[DB] Parse error, using fallback:", e.message);
        CITY_COORDS = { ...FALLBACK_CITIES };
      }
    });
  }).on("error", (err) => {
    console.error("[DB] Download failed, using fallback:", err.message);
    CITY_COORDS = { ...FALLBACK_CITIES };
  });
}

loadCitiesFromGithub();
setInterval(loadCitiesFromGithub, 60 * 60 * 1000);

// ── GeoJSON של גבולות רשויות מקומיות ──────────────────
let cachedGeoJSON = null;
let geoLoadAttempts = 0;
const MAX_GEO_ATTEMPTS = 3;

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 20000, headers: { "User-Agent": "RocketAlertPWA/1.0" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    }).on("error", reject).on("timeout", function () { this.destroy(); reject(new Error("timeout")); });
  });
}

// ── מקורות GeoJSON — ננסה כמה endpoints ──
// ArcGIS Hub datasets expose a GeoJSON download via:
//   https://<hub>/datasets/<id>/downloads/data?format=geojson&spatialRefId=4326
// We also try the ArcGIS FeatureServer query endpoint.
// The org ID for moinil is dlrDjz89gx9qyfev on services5.arcgis.com

const GEOJSON_SOURCES = [];

// ENV override
if (process.env.GEOJSON_URL) {
  GEOJSON_SOURCES.push(process.env.GEOJSON_URL);
  console.log(`[GEO] Using custom GEOJSON_URL from env`);
}

// Real ArcGIS FeatureServer URLs from services5.arcgis.com/dlrDjz89gx9qyfev
GEOJSON_SOURCES.push(
  // authorities_bouderies — גבולות רשויות מקומיות (polygons)
  "https://services5.arcgis.com/dlrDjz89gx9qyfev/ArcGIS/rest/services/authorities_bouderies/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson&resultRecordCount=2000",
  // authorities_bounding — alternative
  "https://services5.arcgis.com/dlrDjz89gx9qyfev/ArcGIS/rest/services/authorities_bounding/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=geojson&resultRecordCount=2000",
);

async function loadGeoJSON() {
  for (const url of GEOJSON_SOURCES) {
    const shortName = url.substring(0, 80) + "...";
    try {
      console.log(`[GEO] Trying: ${shortName}`);
      const raw = await fetchUrl(url);
      const geo = JSON.parse(raw);

      if (geo && geo.features && geo.features.length > 10) {
        normalizeGeoProperties(geo);
        cachedGeoJSON = geo;
        console.log(`[GEO] SUCCESS — loaded ${geo.features.length} boundaries`);
        return;
      } else if (geo && geo.error) {
        console.warn(`[GEO] ArcGIS error: ${JSON.stringify(geo.error).substring(0, 100)}`);
      } else {
        console.warn(`[GEO] Source returned ${geo?.features?.length || 0} features — too few`);
      }
    } catch (e) {
      console.warn(`[GEO] Failed: ${e.message}`);
    }
  }

  geoLoadAttempts++;
  if (geoLoadAttempts < MAX_GEO_ATTEMPTS) {
    console.log(`[GEO] All sources failed, retry in 60s (attempt ${geoLoadAttempts}/${MAX_GEO_ATTEMPTS})`);
    setTimeout(loadGeoJSON, 60000);
  } else {
    // Fallback: generate Voronoi polygons from city coordinates
    console.log("[GEO] Generating Voronoi polygons from city database...");
    generateVoronoiGeoJSON();
  }
}

// ── Voronoi polygon generation from city coords ──────────
// Creates non-overlapping polygons for each city using Voronoi tessellation
function generateVoronoiGeoJSON() {
  const cities = Object.entries(CITY_COORDS);
  if (cities.length < 10) {
    console.warn("[GEO] Not enough cities for Voronoi");
    return;
  }

  // Israel bounding box (slightly expanded)
  const BBOX = { minLng: 34.0, maxLng: 36.0, minLat: 29.0, maxLat: 33.5 };

  const features = [];

  cities.forEach(([name, coords]) => {
    const lat = coords[0];
    const lng = coords[1];
    // Longitude correction factor at this latitude
    const lngScale = Math.cos(lat * Math.PI / 180);

    const distances = [];
    cities.forEach(([otherName, otherCoords]) => {
      if (otherName === name) return;
      const dlat = otherCoords[0] - lat;
      const dlng = (otherCoords[1] - lng) * lngScale;
      const dist = Math.sqrt(dlat * dlat + dlng * dlng);
      distances.push({
        name: otherName,
        lat: otherCoords[0],
        lng: otherCoords[1],
        dist,
        dlat,
        dlng,
      });
    });

    distances.sort((a, b) => a.dist - b.dist);
    const neighbors = distances.slice(0, 16);

    const maxRadius = 0.035; // ~3.5km in degrees
    const points = [];
    const steps = 36;
    const angleStep = Math.PI * 2 / steps;

    for (let i = 0; i < steps; i++) {
      const a = i * angleStep;
      let r = maxRadius;

      // Direction vector for this angle (in corrected space)
      const dirLat = Math.sin(a);
      const dirLng = Math.cos(a);

      for (const nb of neighbors) {
        // Angle of neighbor in corrected space
        const nbAngle = Math.atan2(nb.dlat, nb.dlng);
        const angleDiff = Math.abs(((a - nbAngle + Math.PI * 3) % (Math.PI * 2)) - Math.PI);

        if (angleDiff < Math.PI / 2.5) {
          const halfDist = nb.dist / 2;
          const factor = Math.cos(angleDiff);
          const constrained = halfDist * (0.88 + 0.12 * factor);
          r = Math.min(r, constrained);
        }
      }

      r = Math.max(r, 0.002);
      const pLat = lat + r * dirLat;
      const pLng = lng + r * dirLng / lngScale;

      points.push([
        Math.max(BBOX.minLng, Math.min(BBOX.maxLng, pLng)),
        Math.max(BBOX.minLat, Math.min(BBOX.maxLat, pLat)),
      ]);
    }

    points.push(points[0]);

    features.push({
      type: "Feature",
      properties: { _displayName: name },
      geometry: {
        type: "Polygon",
        coordinates: [points],
      },
    });
  });

  cachedGeoJSON = { type: "FeatureCollection", features };
  console.log(`[GEO] Generated ${features.length} Voronoi polygons from city database`);
}

function normalizeGeoProperties(geo) {
  if (!geo || !geo.features) return;

  // Log field names from first feature for debugging
  if (geo.features.length > 0 && geo.features[0].properties) {
    const sampleProps = geo.features[0].properties;
    console.log(`[GEO] Sample feature properties: ${JSON.stringify(Object.keys(sampleProps))}`);
    console.log(`[GEO] Sample values: ${JSON.stringify(sampleProps).substring(0, 300)}`);
  }

  geo.features.forEach((f) => {
    if (!f.properties) return;
    const p = f.properties;
    // Try many possible Hebrew name fields
    f.properties._displayName =
      p.Muni_Heb || p.MUNI_HEB || p.name_he || p.NAME_HE ||
      p.Heb_Name || p.HEB_NAME || p.MunicipalityName ||
      p["שם_ישוב"] || p["שם_רשות"] || p["שם ישוב"] || p["שם רשות"] ||
      p.shem_yishu || p.SHEM_YISHU || p.Shem_Yish || p.SHEM_YISH ||
      p.Muni_He || p.MUNI_NAME || p.MUN_HEB ||
      p.Muni_Name || p.AUTH_NAME || p.auth_name ||
      p.Name || p.name || p.NAME || "";
  });
}

loadGeoJSON();
setInterval(() => { geoLoadAttempts = 0; loadGeoJSON(); }, 24 * 60 * 60 * 1000);

// ── פונקציות עזר ──────────────────────────────────────────
function resolveCityCoords(cityName) {
  const c = CITY_COORDS[cityName];
  if (!c) return null;
  return { lat: c[0], lng: c[1], radius: c[2] * 1000 };
}

function classifyAlert(cat) {
  // 1 = טילים/רקטות, 2 = כטב"מ, 6 = חדירת מחבלים → alarm (אדום)
  // הכל אחר → warning (כתום)
  const ALARM_CATS = new Set(["1", "2", "6"]);
  return ALARM_CATS.has(String(cat)) ? "alarm" : "warning";
}

// ── ניהול מצב ──────────────────────────────────────────────
let activeCities = new Set();
let activeCityTypes = {};   // { cityName: "alarm" | "warning" }
let activeCityTimes = {};   // { cityName: timestamp } — when the city was added
let releasedRecently = {};  // { cityName: timestamp } — cities released in last 10 min (don't re-alert)
let lastAlertId = null;
let lastAlertData = null;

function alertFingerprint(alertData) {
  if (!alertData) return null;
  const cities = Array.isArray(alertData.data) ? alertData.data.sort().join(",") : "";
  return `${alertData.id || ""}_${cities}`;
}

// ── משיכת נתונים מפיקוד העורף ──────────────────────────────
function fetchAlerts() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "www.oref.org.il",
      path: "/WarningMessages/alert/alerts.json",
      method: "GET",
      agent: orefAgent,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.oref.org.il/",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        "Accept-Charset": "utf-8",
      },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = Buffer.concat(chunks).toString("utf8");
          const cleaned = data.replace(/^\uFEFF/, "").trim();
          if (!cleaned || cleaned === "null" || cleaned === "[]") {
            resolve(null);
            return;
          }
          resolve(JSON.parse(cleaned));
        } catch (e) {
          resolve(null);
        }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

// ── שליפת היסטוריה (לזיהוי שחרור — category 13) ──────────
let lastHistoryCheck = 0;

function fetchHistory() {
  return new Promise((resolve) => {
    const req = https.request({
      hostname: "www.oref.org.il",
      path: "/WarningMessages/alert/History/AlertsHistory.json",
      method: "GET",
      agent: orefAgent,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Referer: "https://www.oref.org.il/",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json",
        "Accept-Charset": "utf-8",
      },
      timeout: 5000,
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        try {
          const data = Buffer.concat(chunks).toString("utf8");
          const cleaned = data.replace(/^\uFEFF/, "").trim();
          if (!cleaned || cleaned === "null") { resolve([]); return; }
          resolve(JSON.parse(cleaned));
        } catch (e) { resolve([]); }
      });
    });
    req.on("error", () => resolve([]));
    req.on("timeout", () => { req.destroy(); resolve([]); });
    req.end();
  });
}

// ── לולאת Polling ──────────────────────────────────────────
async function pollAlerts() {
  try {
    const alertData = await fetchAlerts();

    if (alertData && alertData.id) {
      const cities = Array.isArray(alertData.data) ? alertData.data : [];
      const type = classifyAlert(alertData.cat);

      const fp = alertFingerprint(alertData);
      if (fp !== lastAlertId) {
        lastAlertId = fp;
        lastAlertData = alertData;

        const enriched = cities.map((name) => ({
          name,
          coords: resolveCityCoords(name),
        }));

        const payload = {
          id: alertData.id,
          cat: String(alertData.cat || "1"),
          type,
          title: alertData.title || "התרעה",
          desc: alertData.desc || "",
          cities: enriched,
          timestamp: alertData.alertDate || new Date().toISOString(),
        };

        console.log(`[${type.toUpperCase()}] ${cities.length} cities: ${cities.join(", ")}`);
        io.emit("alert", payload);
      }

      // Accumulate active cities with their type
      cities.forEach((c) => {
        activeCities.add(c);
        activeCityTimes[c] = Date.now();
        if (type === "alarm" || !activeCityTypes[c]) {
          activeCityTypes[c] = type;
        }
      });
    }

    // Check history every 5 seconds for:
    // 1. Explicit releases (category 13)
    // 2. Missed alerts from last 60 seconds
    const now = Date.now();
    if (now - lastHistoryCheck > 5000) {
      lastHistoryCheck = now;
      const history = await fetchHistory();
      if (Array.isArray(history) && history.length > 0) {
        const oneMinuteAgo = new Date(now - 60000);

        // Build a map: for each city, find the LATEST event (alert or release)
        // History is sorted newest-first
        const latestPerCity = {}; // { cityName: { category, alertDate } }
        history.forEach((entry) => {
          if (!entry.data || !entry.alertDate) return;
          // Only track first (newest) entry per city
          if (!latestPerCity[entry.data]) {
            latestPerCity[entry.data] = {
              category: String(entry.category),
              alertDate: entry.alertDate,
            };
          }
        });

        // Apply releases — only if the LATEST event for that city is cat 13
        const releasedCities = [];
        Object.entries(latestPerCity).forEach(([cityName, info]) => {
          if (info.category === "13" && activeCities.has(cityName)) {
            releasedCities.push({ name: cityName, coords: resolveCityCoords(cityName) });
            activeCities.delete(cityName);
            delete activeCityTypes[cityName];
            delete activeCityTimes[cityName];
            releasedRecently[cityName] = now; // Remember so we don't re-alert
          }
        });

        if (releasedCities.length > 0) {
          console.log(`[RELEASE] ${releasedCities.length} cities: ${releasedCities.map(c => c.name).join(", ")}`);
          io.emit("release", { cities: releasedCities });
        }

        // Clean old entries from releasedRecently (older than 10 min)
        Object.keys(releasedRecently).forEach((name) => {
          if (now - releasedRecently[name] > 600000) delete releasedRecently[name];
        });

        // Collect released names for missed-alert filtering
        const releasedNames = new Set(releasedCities.map(c => c.name));

        // Check for missed alerts — recent alerts not in activeCities
        const missedByType = { alarm: [], warning: [] };
        history.forEach((entry) => {
          const cat = String(entry.category);
          if (cat === "13" || !entry.data || !entry.alertDate) return;
          if (releasedNames.has(entry.data)) return;
          if (activeCities.has(entry.data)) return;
          if (releasedRecently[entry.data]) return; // Don't re-alert recently released
          // Only if latest event for this city is NOT a release
          const latest = latestPerCity[entry.data];
          if (latest && latest.category === "13") return;

          const alertTime = new Date(entry.alertDate.replace(" ", "T") + "+02:00");
          if (alertTime > oneMinuteAgo) {
            const type = classifyAlert(cat);
            missedByType[type].push({
              name: entry.data,
              coords: resolveCityCoords(entry.data),
              cat,
            });
            activeCities.add(entry.data);
            activeCityTypes[entry.data] = type;
            activeCityTimes[entry.data] = Date.now();
          }
        });

        for (const [type, cities] of Object.entries(missedByType)) {
          if (cities.length > 0) {
            console.log(`[MISSED] Recovered ${cities.length} ${type} alerts from history`);
            io.emit("alert", {
              id: `history-${type}-${now}`,
              cat: cities[0].cat,
              type,
              title: "התרעה",
              cities,
              timestamp: new Date().toISOString(),
            });
          }
        }
      }
    }

    // Safety timeout: remove cities older than 30 minutes without refresh
    const STALE_TIMEOUT = 30 * 60 * 1000;
    const staleCities = [];
    activeCities.forEach((name) => {
      const addedAt = activeCityTimes[name] || 0;
      if (now - addedAt > STALE_TIMEOUT) {
        staleCities.push(name);
      }
    });
    if (staleCities.length > 0) {
      console.log(`[CLEANUP] Removing ${staleCities.length} stale cities (>30min): ${staleCities.join(", ")}`);
      const released = staleCities.map((name) => {
        activeCities.delete(name);
        delete activeCityTypes[name];
        delete activeCityTimes[name];
        return { name, coords: resolveCityCoords(name) };
      });
      io.emit("release", { cities: released });
    }
  } catch (e) {
    console.error("[POLL] Error:", e.message);
  }
}

// Recursive setTimeout — waits for previous poll to finish before starting next
async function startPolling() {
  await pollAlerts();
  setTimeout(startPolling, POLL_INTERVAL);
}
startPolling();

// ── API & Static ─────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public"), {
  setHeaders: (res, filePath) => {
    // No cache for HTML — always fresh
    if (filePath.endsWith(".html")) {
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  },
}));

// No cache for all API routes
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

app.get("/api/config", (req, res) => {
  res.json({
    defaultCity: DEFAULT_CITY,
    cityList: Object.keys(CITY_COORDS).sort((a, b) => a.localeCompare(b, "he")),
  });
});

app.get("/api/geojson", (req, res) => {
  if (cachedGeoJSON) {
    // Override: allow browser to cache GeoJSON for 1 hour (it's large and static)
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.json(cachedGeoJSON);
  } else {
    res.status(503).json({ error: "GeoJSON not loaded yet", fallback: true });
  }
});

app.get("/api/geojson-status", (req, res) => {
  res.json({
    loaded: !!cachedGeoJSON,
    featureCount: cachedGeoJSON ? cachedGeoJSON.features.length : 0,
    sampleNames: cachedGeoJSON ? cachedGeoJSON.features.slice(0, 5).map(f => f.properties?._displayName || "?") : [],
    attempts: geoLoadAttempts,
  });
});

app.get("/api/last-alert", (req, res) => {
  if (activeCities.size > 0) {
    // Group cities by type and send as separate alerts
    const groups = {};
    activeCities.forEach((name) => {
      const type = activeCityTypes[name] || "alarm";
      if (!groups[type]) groups[type] = [];
      groups[type].push({ name, coords: resolveCityCoords(name) });
    });
    // Return as array of alerts
    const alerts = Object.entries(groups).map(([type, cities]) => ({
      id: "restore-" + type,
      cat: type === "alarm" ? "1" : "3",
      type,
      title: type === "alarm" ? "צבע אדום" : "התרעה",
      cities,
      timestamp: lastAlertData?.alertDate || null,
    }));
    res.json(alerts);
  } else {
    res.json(null);
  }
});

io.on("connection", (socket) => {
  console.log(`[WS] Connected: ${socket.id}`);
  socket.on("disconnect", () => console.log(`[WS] Disconnected: ${socket.id}`));
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[SERVER] Running on port ${PORT}`);
  console.log(`[SERVER] Poll interval: ${POLL_INTERVAL}ms`);
  console.log(`[SERVER] Cities DB: ${Object.keys(CITY_COORDS).length} loaded (fetching more from GitHub...)`);
});
