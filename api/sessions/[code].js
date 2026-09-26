const { redis, sessionKey, SESSION_TTL_SECONDS } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);

  const { code } = req.query;
  if (!code) {
    res.status(400).json({ success: false, error: "missing-code" });
    return;
  }

  const key = sessionKey(String(code).toUpperCase());

  if (req.method === "GET") {
    try {
      const raw = await redis.get(key);
      if (!raw) {
        res.status(404).json({ success: false, error: "not-found" });
        return;
      }
      const session = typeof raw === "string" ? JSON.parse(raw) : raw;
      res.status(200).json(session);
    } catch {
      res.status(500).json({ success: false, error: "server-error" });
    }
    return;
  }

  if (req.method === "PUT") {
    try {
      const raw = await redis.get(key);
      if (!raw) {
        res.status(404).json({ success: false, error: "not-found" });
        return;
      }
      const existing = typeof raw === "string" ? JSON.parse(raw) : raw;
      const updated = { ...existing, ...(req.body || {}) };
      await redis.set(key, JSON.stringify(updated), { ex: SESSION_TTL_SECONDS });
      res.status(200).json({ success: true });
    } catch {
      res.status(500).json({ success: false, error: "server-error" });
    }
    return;
  }

  res.status(405).json({ success: false, error: "method-not-allowed" });
};
