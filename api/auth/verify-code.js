const crypto = require("crypto");
const { redis } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const auth = require("../_auth");

// POST { email, code } -> signs the driver in (creating the account on first use).
// Signing in during the 30-day deletion grace period cancels the deletion.
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method-not-allowed" });

  try {
    const email = auth.normalizeEmail(req.body?.email);
    if (!auth.isValidEmail(email)) return res.status(400).json({ success: false, error: "invalid-email" });

    const result = await auth.checkOtp(email, req.body?.code);
    if (result !== "ok") return res.status(400).json({ success: false, error: result === "expired" ? "code-expired" : "invalid-code" });

    let driverId = await redis.get(auth.keys.driverByEmail(email));
    let restored = false;
    let created = false;

    if (driverId) {
      driverId = String(driverId);
      const existing = await auth.getDriver(driverId);
      if (existing && Number(existing.deleteAfter)) {
        await auth.cancelDeletion(driverId);
        restored = true;
      }
    } else {
      driverId = `d_${crypto.randomBytes(8).toString("hex")}`;
      await redis.hset(auth.keys.driver(driverId), {
        id: driverId,
        email,
        name: "",
        phone: "",
        vehicleModel: "",
        licensePlate: "",
        createdAt: Date.now(),
        sessionsTotal: 0,
        waitingCount: 0,
        tripCount: 0,
      });
      await redis.set(auth.keys.driverByEmail(email), driverId);
      await redis.sadd(auth.keys.allDrivers, driverId);
      created = true;
    }

    await redis.hset(auth.keys.driver(driverId), { lastActiveAt: Date.now() });
    const token = await auth.issueToken(driverId);
    const driver = auth.publicDriver(await auth.getDriver(driverId));

    res.status(200).json({ success: true, token, driver, created, restored });
  } catch (error) {
    console.error("verify-code", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
