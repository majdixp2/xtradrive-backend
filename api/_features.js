const { redis } = require("./_redis");
const auth = require("./_auth");

// Remote switches for app features. A feature missing from Redis is OFF,
// so a brand-new feature stays hidden until the admin turns it on.
const FEATURE_DEFAULTS = {
  destinationMode: false,
  rideHailing: false,
};

async function readFeatures() {
  const raw = await redis.get(auth.keys.features);
  const saved = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : {};
  const out = {};
  for (const key of Object.keys(FEATURE_DEFAULTS)) {
    out[key] = typeof saved?.[key] === "boolean" ? saved[key] : FEATURE_DEFAULTS[key];
  }
  return out;
}

async function writeFeatures(changes) {
  const current = await readFeatures();
  for (const key of Object.keys(changes)) {
    if (!(key in FEATURE_DEFAULTS) || typeof changes[key] !== "boolean") throw new Error("invalid-features");
    current[key] = changes[key];
  }
  await redis.set(auth.keys.features, JSON.stringify(current));
  return current;
}

module.exports = { FEATURE_DEFAULTS, readFeatures, writeFeatures };
