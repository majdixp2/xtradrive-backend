const { redis } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const auth = require("../_auth");

// GET    -> the signed-in driver's profile
// PUT    -> update { name, phone, vehicleModel, licensePlate }
// DELETE -> request account deletion (signed out now, erased after 30 days)
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);

  try {
    const driver = await auth.requireDriver(req, res);
    if (!driver) return;

    if (req.method === "GET") {
      await redis.hset(auth.keys.driver(driver.id), { lastActiveAt: Date.now() });
      return res.status(200).json({ success: true, driver: auth.publicDriver(driver) });
    }

    if (req.method === "PUT") {
      const updates = {};
      for (const field of auth.PROFILE_FIELDS) {
        if (req.body && field in req.body) {
          updates[field] = String(req.body[field] ?? "").trim().slice(0, 80);
        }
      }
      if (Object.keys(updates).length) await redis.hset(auth.keys.driver(driver.id), updates);
      const fresh = await auth.getDriver(driver.id);
      return res.status(200).json({ success: true, driver: auth.publicDriver(fresh) });
    }

    if (req.method === "DELETE") {
      const deleteAfter = await auth.scheduleDeletion(driver);
      return res.status(200).json({ success: true, deleteAfter, graceDays: auth.DELETION_GRACE_DAYS });
    }

    res.status(405).json({ success: false, error: "method-not-allowed" });
  } catch (error) {
    console.error("me", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
