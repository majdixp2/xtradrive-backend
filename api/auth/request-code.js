const { redis } = require("../_redis");
const { withCors, handlePreflight } = require("../_cors");
const { sendCodeEmail } = require("../_mail");
const auth = require("../_auth");

// POST { email, purpose?: "login" | "delete" } -> emails a 6-digit code.
module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  if (req.method !== "POST") return res.status(405).json({ success: false, error: "method-not-allowed" });

  try {
    const email = auth.normalizeEmail(req.body?.email);
    const purpose = req.body?.purpose === "delete" ? "delete" : "login";
    if (!auth.isValidEmail(email)) return res.status(400).json({ success: false, error: "invalid-email" });

    // Reviewer account: nothing to send, the fixed code works.
    if (auth.isReviewEmail(email)) return res.status(200).json({ success: true });

    // A deletion code is only useful for an existing account.
    if (purpose === "delete" && !(await redis.get(auth.keys.driverByEmail(email)))) {
      return res.status(404).json({ success: false, error: "no-account" });
    }

    // Anti-abuse limits: 1 code per minute and 5 per hour per email, 30 per hour per network.
    if (await redis.get(auth.keys.otpCooldown(email))) {
      return res.status(429).json({ success: false, error: "wait-a-minute" });
    }
    const hourly = await redis.incr(auth.keys.otpHourly(email));
    if (hourly === 1) await redis.expire(auth.keys.otpHourly(email), 3600);
    const ipCount = await redis.incr(auth.keys.otpIp(auth.clientIp(req)));
    if (ipCount === 1) await redis.expire(auth.keys.otpIp(auth.clientIp(req)), 3600);
    if (hourly > 5 || ipCount > 30) return res.status(429).json({ success: false, error: "too-many-requests" });

    const code = auth.generateOtp();
    await redis.set(
      auth.keys.otp(email),
      JSON.stringify({ hash: auth.sha256(`${email}:${code}`), attempts: 0 }),
      { ex: auth.OTP_TTL_SECONDS },
    );
    try {
      await sendCodeEmail(email, code, purpose);
    } catch (mailError) {
      // Don't count a failed send against the driver's limits.
      console.error("request-code: email failed", mailError?.code, mailError?.response || mailError?.message);
      await redis.del(auth.keys.otp(email));
      await redis.decr(auth.keys.otpHourly(email));
      return res.status(502).json({ success: false, error: "email-failed" });
    }
    await redis.set(auth.keys.otpCooldown(email), 1, { ex: 60 });

    res.status(200).json({ success: true });
  } catch (error) {
    console.error("request-code", error);
    res.status(500).json({ success: false, error: "server-error" });
  }
};
