const { redis, sessionKey, SESSION_TTL_SECONDS } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const { generateSessionCode } = require("../_code");
const auth = require("../_auth");

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);

  if (req.method !== "POST") {
    res.status(405).json({ success: false, error: "method-not-allowed" });
    return;
  }

  try {
    const body = req.body || {};
    const { type, pricePerSecond, pricePerMeter, baseFare, currency } = body;
    // Signed-in drivers are identified by their token; older app versions still send a local id.
    const authedDriver = await auth.getAuthedDriver(req);
    const driverId = authedDriver ? authedDriver.id : body.driverId;

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

    // Usage counters (numbers only, no ride details are kept).
    const kind = type === "trip" ? "trip" : "waiting";
    const dayKey = auth.keys.dayStats(auth.todayKey());
    await redis.hincrby(dayKey, "total", 1);
    await redis.hincrby(dayKey, kind, 1);
    await redis.expire(dayKey, 60 * 60 * 24 * 400);
    if (authedDriver) {
      const driverKey = auth.keys.driver(authedDriver.id);
      await redis.hincrby(driverKey, "sessionsTotal", 1);
      await redis.hincrby(driverKey, kind === "trip" ? "tripCount" : "waitingCount", 1);
      await redis.hset(driverKey, { lastActiveAt: Date.now() });
    }

    res.status(200).json({ success: true, code });
  } catch (error) {
    res.status(500).json({ success: false, error: "server-error" });
  }
};
