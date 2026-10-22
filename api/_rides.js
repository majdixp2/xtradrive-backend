const crypto = require("crypto");
const { redis } = require("./_redis");

// ---- Settings ----
const OPEN_WINDOW_MS = 3 * 60 * 1000;        // a request waits this long for a captain
const DEMO_WINDOW_MS = 10 * 60 * 1000;       // demo requests stay a bit longer for testing
const OFFER_WINDOW_MS = 30 * 1000;           // a +10% / +20% counter-offer waits this long for the rider
const RIDE_TTL_SECONDS = 6 * 60 * 60;        // ride records are erased after 6 hours
const SEARCH_RADIUS_KM = 20;                 // captains see requests within this distance
const MAX_CREATES_PER_HOUR = 10;

const PRICING_DEFAULTS = {
  baseFare: 5,          // SAR
  perKm: 1.6,           // SAR per km
  perMinute: 0.3,       // SAR per minute
  minFare: 12,          // SAR
  counterPercents: [10, 20],
  currency: "SAR",
};

const keys = {
  ride: (id) => `ride:${id}`,
  open: "rides:open",
  assign: (id) => `ride-assign:${id}`,
  offers: (id) => `ride-offers:${id}`,
  riderActive: (riderId) => `rider-active:${riderId}`,
  driverActive: (driverId) => `driver-active:${driverId}`,
  createRate: (riderId) => `ride-create-rate:${riderId}`,
  pricing: "config:ride-pricing",
};

function parse(raw) {
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

function newId() {
  return crypto.randomBytes(9).toString("base64url");
}

// ---- Geometry ----
function toRad(d) {
  return (d * Math.PI) / 180;
}

function distanceKm(a, b) {
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Compass bearing in degrees (0 = north, 90 = east) from a to b. */
function bearing(a, b) {
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

/** Pickup shown to captains before they accept: shifted up to ~180 m, stable per ride. */
function approximate(point, seed) {
  const h = crypto.createHash("sha256").update(seed).digest();
  const angle = (h[0] / 255) * 2 * Math.PI;
  const meters = 80 + (h[1] / 255) * 100;
  const dLat = (meters * Math.cos(angle)) / 111320;
  const dLng = (meters * Math.sin(angle)) / (111320 * Math.cos(toRad(point.lat)));
  return { lat: +(point.lat + dLat).toFixed(5), lng: +(point.lng + dLng).toFixed(5) };
}

function cleanPoint(p) {
  const lat = Number(p?.lat);
  const lng = Number(p?.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat: +lat.toFixed(6), lng: +lng.toFixed(6), label: String(p?.label || "").slice(0, 140) };
}

// ---- Pricing ----
async function readPricing() {
  const saved = parse(await redis.get(keys.pricing)) || {};
  return { ...PRICING_DEFAULTS, ...saved };
}

function fareFor(pricing, km, minutes) {
  const raw = pricing.baseFare + pricing.perKm * km + pricing.perMinute * minutes;
  return Math.max(pricing.minFare, Math.round(raw));
}

function counterPrice(price, pct) {
  return Math.round(price * (1 + pct / 100));
}

/**
 * Road distance and time. Uses OpenRouteService when the key is set and it
 * answers quickly; otherwise a straight-line estimate (x1.3 for roads, ~32 km/h).
 */
async function routeEstimate(from, to) {
  const straight = distanceKm(from, to);
  const fallback = { distanceKm: +(straight * 1.3).toFixed(1), durationMin: Math.max(3, Math.round(((straight * 1.3) / 32) * 60)), source: "estimate" };
  const key = process.env.ORS_API_KEY;
  if (!key || straight < 0.05) return fallback;

  const body = JSON.stringify({ coordinates: [[from.lng, from.lat], [to.lng, to.lat]], instructions: false });
  const urls = [
    "https://api.heigit.org/openrouteservice/v2/directions/driving-car",
    "https://api.openrouteservice.org/v2/directions/driving-car",
  ];
  for (const url of urls) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(url, {
        method: "POST",
        headers: { Authorization: key, "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const data = await res.json();
      const summary = data?.routes?.[0]?.summary;
      if (summary && Number.isFinite(summary.distance)) {
        return {
          distanceKm: +(summary.distance / 1000).toFixed(1),
          durationMin: Math.max(1, Math.round((summary.duration || 0) / 60)),
          source: "route",
        };
      }
    } catch (error) {
      // try the next URL, then fall back
    }
  }
  return fallback;
}

// ---- Records ----
async function getRide(id) {
  if (!id || typeof id !== "string" || id.length > 40) return null;
  return parse(await redis.get(keys.ride(id)));
}

async function saveRide(ride) {
  await redis.set(keys.ride(ride.id), JSON.stringify(ride), { ex: RIDE_TTL_SECONDS });
  return ride;
}

async function getOffers(id) {
  const all = (await redis.hgetall(keys.offers(id))) || {};
  const now = Date.now();
  return Object.values(all).map(parse).filter((o) => o && o.expiresAt > now);
}

module.exports = {
  OPEN_WINDOW_MS,
  DEMO_WINDOW_MS,
  OFFER_WINDOW_MS,
  RIDE_TTL_SECONDS,
  SEARCH_RADIUS_KM,
  MAX_CREATES_PER_HOUR,
  PRICING_DEFAULTS,
  keys,
  parse,
  newId,
  distanceKm,
  bearing,
  approximate,
  cleanPoint,
  readPricing,
  fareFor,
  counterPrice,
  routeEstimate,
  getRide,
  saveRide,
  getOffers,
};
