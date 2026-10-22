const { withCors, handlePreflight } = require("./_cors");
const auth = require("./_auth");
const { readFeatures, writeFeatures } = require("./_features");

// GET -> { success, features: { destinationMode, rideHailing, ... } }  (public, uncached)
// PUT { features: { rideHailing: true } } -> admin only, applies to every driver right away.
// (Kept in one file: the Vercel Hobby plan allows at most 12 functions.)
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "GET") {
      return res.status(200).json({ success: true, features: await readFeatures() });
    }
    if (req.method === "PUT") {
      const admin = await auth.requireAdmin(req, res);
      if (!admin) return;
      const incoming = req.body?.features;
      if (!incoming || typeof incoming !== "object") return res.status(400).json({ success: false, error: "invalid-features" });
      try {
        return res.status(200).json({ success: true, features: await writeFeatures(incoming) });
      } catch {
        return res.status(400).json({ success: false, error: "invalid-features" });
      }
    }
    res.status(405).json({ success: false, error: "method-not-allowed" });
  } catch (error) {
    console.error("features", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
