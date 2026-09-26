const { redis, sessionKey, SESSION_TTL_SECONDS } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const { generateSessionCode } = require("../_code");

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);

  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "method-not-allowed" });
    return;
  }

  try {
    const body = req.body || {};
    const { type, pricePerSecond, pricePerMeter, baseFare, currency, driverId } = body;

    if (!type || !pricePerSecond || !pricePerMeter || !driverId) {
      res.status(400).json({ success: false, error: "missing-fields" });
      return;
    }

    let code = generateSessionCode();
    // Extremely unlikely, but guard against a rare code collision.
    for (let attempt = 0; attempt < 5; attempt++) {
      const exists = await redis.exists(sessionKey(code));
      if (!exists) break;
      code = generateSessionCode();
    }

    const session = {
      code,
      type,
      pricePerSecond: String(pricePerSecond),
      pricePerMeter: String(pricePerMeter),
      baseFare: String(baseFare ?? "0.00"),
      currency: currency || "SAR",
      driverId,
      status: "waiting",
      seconds: 0,
      distance: 0,
      timeEarnings: "0.00",
      distanceEarnings: "0.00",
      totalEarnings: String(baseFare ?? "0.00"),
      createdAt: Date.now(),
    };

    await redis.set(sessionKey(code), JSON.stringify(session), { ex: SESSION_TTL_SECONDS });

    res.status(200).json({ success: true, code });
  } catch (error) {
    res.status(500).json({ success: false, error: "server-error" });
  }
};
