const { redis } = require("./_redis");
const { withCors, handlePreflight } = require("./_cors");
const auth = require("./_auth");

// GET -> the pricing set by the admin (null until the admin saves one,
// in which case the app keeps using its built-in defaults).
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "method-not-allowed" });
  try {
    const raw = await redis.get(auth.keys.pricing);
    const categories = raw ? (typeof raw === "string" ? JSON.parse(raw) : raw) : null;
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ success: true, categories });
  } catch (error) {
    console.error("pricing", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
