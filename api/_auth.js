const crypto = require("crypto");
const { redis } = require("./_redis");

// ---- Settings ----
const OTP_TTL_SECONDS = 10 * 60;              // a login code is valid for 10 minutes
const OTP_MAX_ATTEMPTS = 5;                   // wrong guesses before the code is burned
const TOKEN_TTL_SECONDS = 180 * 24 * 60 * 60; // a driver stays signed in ~6 months
const DELETION_GRACE_DAYS = 30;               // account data kept 30 days after a deletion request
const DAY_MS = 24 * 60 * 60 * 1000;

// ---- Keys ----
const keys = {
  otp: (email) => `otp:${email}`,
  otpCooldown: (email) => `otp-cooldown:${email}`,
  otpHourly: (email) => `otp-hourly:${email}`,
  otpIp: (ip) => `otp-ip:${ip}`,
  driver: (id) => `driver:${id}`,
  driverByEmail: (email) => `driver-email:${email}`,
  driverTokens: (id) => `driver-tokens:${id}`,
  token: (hash) => `auth:${hash}`,
  allDrivers: "drivers:all",
  deletions: "deletions",
  pricing: "config:pricing",
  dayStats: (day) => `stats:day:${day}`,
};

const PROFILE_FIELDS = ["name", "phone", "vehicleModel", "licensePlate"];

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function listFromEnv(name) {
  return String(process.env[name] || "")
    .split(",")
    .map(normalizeEmail)
    .filter(Boolean);
}

function isAdminEmail(email) {
  return listFromEnv("ADMIN_EMAILS").includes(normalizeEmail(email));
}

// Account used by Google Play reviewers: they cannot read our mailbox, so it
// accepts a fixed code set in Vercel instead of an emailed one.
function isReviewEmail(email) {
  const reviewEmail = normalizeEmail(process.env.REVIEW_EMAIL);
  return Boolean(reviewEmail) && normalizeEmail(email) === reviewEmail && Boolean(process.env.REVIEW_CODE);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || "unknown";
}

function todayKey(date = new Date()) {
  // Saudi Arabia is UTC+3 with no daylight saving.
  const local = new Date(date.getTime() + 3 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 10);
}

function publicDriver(driver) {
  if (!driver) return null;
  return {
    id: driver.id,
    email: driver.email,
    name: driver.name || "",
    phone: driver.phone || "",
    vehicleModel: driver.vehicleModel || "",
    licensePlate: driver.licensePlate || "",
    createdAt: Number(driver.createdAt) || 0,
    sessionsTotal: Number(driver.sessionsTotal) || 0,
    waitingCount: Number(driver.waitingCount) || 0,
    tripCount: Number(driver.tripCount) || 0,
    lastActiveAt: Number(driver.lastActiveAt) || 0,
    deleteAfter: Number(driver.deleteAfter) || 0,
    isAdmin: isAdminEmail(driver.email),
    profileComplete: Boolean(driver.name && driver.phone),
  };
}

async function getDriver(id) {
  if (!id) return null;
  const driver = await redis.hgetall(keys.driver(id));
  return driver && driver.id ? driver : null;
}

async function issueToken(driverId) {
  const token = crypto.randomBytes(32).toString("hex");
  const hash = sha256(token);
  await redis.set(keys.token(hash), driverId, { ex: TOKEN_TTL_SECONDS });
  await redis.sadd(keys.driverTokens(driverId), hash);
  return token;
}

async function revokeAllTokens(driverId) {
  const hashes = (await redis.smembers(keys.driverTokens(driverId))) || [];
  if (hashes.length) await redis.del(...hashes.map(keys.token));
  await redis.del(keys.driverTokens(driverId));
}

function readBearer(req) {
  const header = String(req.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

// Returns the signed-in driver, or null. Accounts pending deletion are signed out.
async function getAuthedDriver(req) {
  const token = readBearer(req);
  if (!token) return null;
  const driverId = await redis.get(keys.token(sha256(token)));
  if (!driverId) return null;
  const driver = await getDriver(String(driverId));
  if (!driver || Number(driver.deleteAfter)) return null;
  return driver;
}

async function requireDriver(req, res) {
  const driver = await getAuthedDriver(req);
  if (!driver) {
    res.status(401).json({ success: false, error: "unauthorized" });
    return null;
  }
  return driver;
}

async function requireAdmin(req, res) {
  const driver = await requireDriver(req, res);
  if (!driver) return null;
  if (!isAdminEmail(driver.email)) {
    res.status(403).json({ success: false, error: "forbidden" });
    return null;
  }
  return driver;
}

// ---- One-time codes ----
function generateOtp() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

// Checks a code. Returns "ok", "invalid", or "expired" (missing / too many tries).
async function checkOtp(email, code) {
  const cleanCode = String(code || "").replace(/\D/g, "");
  if (isReviewEmail(email)) {
    return cleanCode === String(process.env.REVIEW_CODE) ? "ok" : "invalid";
  }
  const raw = await redis.get(keys.otp(email));
  if (!raw) return "expired";
  const record = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await redis.del(keys.otp(email));
    return "expired";
  }
  if (record.hash !== sha256(`${email}:${cleanCode}`)) {
    record.attempts += 1;
    const ttl = await redis.ttl(keys.otp(email));
    await redis.set(keys.otp(email), JSON.stringify(record), { ex: Math.max(ttl, 1) });
    return "invalid";
  }
  await redis.del(keys.otp(email));
  return "ok";
}

// ---- Deletion ----
async function scheduleDeletion(driver) {
  const deleteAfter = Date.now() + DELETION_GRACE_DAYS * DAY_MS;
  await redis.hset(keys.driver(driver.id), { deleteAfter, deletionRequestedAt: Date.now() });
  await redis.zadd(keys.deletions, { score: deleteAfter, member: driver.id });
  await revokeAllTokens(driver.id);
  return deleteAfter;
}

async function cancelDeletion(driverId) {
  await redis.hdel(keys.driver(driverId), "deleteAfter", "deletionRequestedAt");
  await redis.zrem(keys.deletions, driverId);
}

// Permanently removes every account whose grace period has ended.
async function purgeExpiredDeletions() {
  const due = (await redis.zrange(keys.deletions, 0, Date.now(), { byScore: true })) || [];
  for (const id of due) {
    const driver = await getDriver(id);
    if (driver && driver.email) await redis.del(keys.driverByEmail(driver.email));
    await revokeAllTokens(id);
    await redis.del(keys.driver(id));
    await redis.srem(keys.allDrivers, id);
    await redis.zrem(keys.deletions, id);
  }
  return due.length;
}

module.exports = {
  keys,
  PROFILE_FIELDS,
  OTP_TTL_SECONDS,
  DELETION_GRACE_DAYS,
  normalizeEmail,
  isValidEmail,
  sha256,
  isAdminEmail,
  isReviewEmail,
  clientIp,
  todayKey,
  publicDriver,
  getDriver,
  issueToken,
  getAuthedDriver,
  requireDriver,
  requireAdmin,
  generateOtp,
  checkOtp,
  scheduleDeletion,
  cancelDeletion,
  purgeExpiredDeletions,
};
