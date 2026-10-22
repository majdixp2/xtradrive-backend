const { redis } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const auth = require("../_auth");
const { FEATURE_DEFAULTS, readFeatures } = require("../_features");

// PUT { features: { destinationMode: boolean } } -> turns features on/off for every driver (admin only).
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  if (req.method !== "PUT") return res.status(405).json({ success: false, error: "method-not-allowed" });

  try {
    const admin = await auth.requireAdmin(req, res);
    if (!admin) return;

    const incoming = req.body?.features;
    if (!incoming || typeof incoming !== "object") return res.status(400).json({ success: false, error: "invalid-features" });

    const current = await readFeatures();
    for (const key of Object.keys(incoming)) {
      if (!(key in FEATURE_DEFAULTS) || typeof incoming[key] !== "boolean") {
        return res.status(400).json({ success: false, error: "invalid-features" });
      }
      current[key] = incoming[key];
    }

    await redis.set(auth.keys.features, JSON.stringify(current));
    res.status(200).json({ success: true, features: current });
  } catch (error) {
    console.error("admin-features", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
