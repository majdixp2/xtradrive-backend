const { redis } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const auth = require("../_auth");

// Web deletion (for drivers without the app): POST { email, code }.
// The code comes from /api/auth/request-code with purpose "delete".
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method-not-allowed" });

  try {
    const email = auth.normalizeEmail(req.body?.email);
    if (!auth.isValidEmail(email)) return res.status(400).json({ success: false, error: "invalid-email" });

    const result = await auth.checkOtp(email, req.body?.code);
    if (result !== "ok") return res.status(400).json({ success: false, error: result === "expired" ? "code-expired" : "invalid-code" });

    const driverId = await redis.get(auth.keys.driverByEmail(email));
    const driver = driverId ? await auth.getDriver(String(driverId)) : null;
    if (!driver) return res.status(404).json({ success: false, error: "no-account" });

    const deleteAfter = Number(driver.deleteAfter) || (await auth.scheduleDeletion(driver));
    res.status(200).json({ success: true, deleteAfter, graceDays: auth.DELETION_GRACE_DAYS });
  } catch (error) {
    console.error("delete-account", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
