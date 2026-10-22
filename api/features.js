const { withCors, handlePreflight } = require("./_cors");
const { readFeatures } = require("./_features");

// GET -> { success, features: { destinationMode: boolean, ... } }
// Public and uncached so a switch flipped by the admin reaches drivers right away.
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "method-not-allowed" });
  try {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ success: true, features: await readFeatures() });
  } catch (error) {
    console.error("features", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
