const auth = require("../_auth");

// Runs daily (see vercel.json): permanently erases accounts whose 30-day
// deletion grace period has ended. Vercel sends CRON_SECRET automatically.
module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  try {
    const purged = await auth.purgeExpiredDeletions();
    res.status(200).json({ success: true, purged });
  } catch (error) {
    console.error("purge", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
