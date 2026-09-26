const { Redis } = require("@upstash/redis");

// Vercel's Upstash integration auto-injects these two env vars once the
// Redis database is connected to this project. No manual config needed.
const redis = Redis.fromEnv();

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours — a ride session never legitimately outlives this.

function sessionKey(code) {
  return `session:${code}`;
}

module.exports = { redis, sessionKey, SESSION_TTL_SECONDS };
