const { redis } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const auth = require("../_auth");

// GET -> all drivers with their usage, plus daily totals for the last 14 days (admin only).
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  if (req.method !== "GET") return res.status(405).json({ success: false, error: "method-not-allowed" });

  try {
    const admin = await auth.requireAdmin(req, res);
    if (!admin) return;

    await auth.purgeExpiredDeletions();

    const ids = (await redis.smembers(auth.keys.allDrivers)) || [];
    const drivers = (await Promise.all(ids.map((id) => auth.getDriver(id))))
      .filter(Boolean)
      .map(auth.publicDriver)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const day = auth.todayKey(new Date(Date.now() - i * 24 * 60 * 60 * 1000));
      const stats = (await redis.hgetall(auth.keys.dayStats(day))) || {};
      days.push({
        day,
        total: Number(stats.total) || 0,
        waiting: Number(stats.waiting) || 0,
        trip: Number(stats.trip) || 0,
        newDrivers: drivers.filter((d) => auth.todayKey(new Date(d.createdAt)) === day).length,
      });
    }

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      success: true,
      totals: {
        drivers: drivers.length,
        pendingDeletion: drivers.filter((d) => d.deleteAfter).length,
        sessions: drivers.reduce((sum, d) => sum + d.sessionsTotal, 0),
      },
      days,
      drivers,
    });
  } catch (error) {
    console.error("admin-drivers", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
