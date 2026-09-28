const { redis } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const auth = require("../_auth");

function isPositiveNumber(value, allowZero = true) {
  const n = Number(value);
  return Number.isFinite(n) && (allowZero ? n >= 0 : n > 0) && n < 10_000;
}

// PUT { categories: VehiclePricing[] } -> saves pricing for every driver (admin only).
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  if (req.method !== "PUT") return res.status(405).json({ success: false, error: "method-not-allowed" });

  try {
    const admin = await auth.requireAdmin(req, res);
    if (!admin) return;

    const categories = req.body?.categories;
    if (!Array.isArray(categories) || !categories.length || categories.length > 10) {
      return res.status(400).json({ success: false, error: "invalid-pricing" });
    }
    const clean = [];
    for (const c of categories) {
      if (!c || typeof c.id !== "string" || !isPositiveNumber(c.costPerMinute, false) || !isPositiveNumber(c.costPerKm) || !isPositiveNumber(c.baseFare)) {
        return res.status(400).json({ success: false, error: "invalid-pricing" });
      }
      clean.push({
        id: c.id.slice(0, 40),
        name: { ar: String(c.name?.ar || c.id).slice(0, 40), en: String(c.name?.en || c.id).slice(0, 40) },
        costPerMinute: Number(c.costPerMinute),
        costPerKm: Number(c.costPerKm),
        baseFare: Number(c.baseFare),
        enabled: Boolean(c.enabled),
      });
    }
    if (!clean.some((c) => c.enabled)) return res.status(400).json({ success: false, error: "no-enabled-category" });

    await redis.set(auth.keys.pricing, JSON.stringify(clean));
    res.status(200).json({ success: true, categories: clean });
  } catch (error) {
    console.error("admin-pricing", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
