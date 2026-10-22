const { redis } = require("./_redis");
const { withCors, handlePreflight } = require("./_cors");
const auth = require("./_auth");
const { readFeatures } = require("./_features");
const R = require("./_rides");

// Ride requests (rider ↔ captain). One file on purpose: the Vercel Hobby plan allows 12 functions.
//
//   GET  /api/rides?lat=..&lng=..        captain: open requests nearby + my active ride
//   GET  /api/rides?id=..[&as=rider]     rider / assigned captain: one ride (status, offers, captain)
//   GET  /api/rides?mine=1               rider: my current ride, if any
//   POST /api/rides { action: "estimate", pickup, dropoff }
//   POST /api/rides { action: "create",   pickup, dropoff }
//   POST /api/rides { action: "accept",   id, pct (0 | 10 | 20), lat?, lng? }
//   POST /api/rides { action: "select-offer", id, driverId }
//   POST /api/rides { action: "cancel",   id }
//   POST /api/rides { action: "complete", id }
//   POST /api/rides { action: "demo",     lat, lng, count }        admin
//   POST /api/rides { action: "pricing",  pricing }                admin
//
// Everything is closed unless the "rideHailing" switch is on (admins can always test).

function fail(res, status, error) {
  res.status(status).json({ success: false, error });
}

async function allowed(driver) {
  if (auth.isAdminEmail(driver.email)) return true;
  return (await readFeatures()).rideHailing === true;
}

function captainCard(driver) {
  if (!driver) return null;
  return {
    id: driver.id,
    name: driver.name || "",
    phone: driver.phone || "",
    vehicleModel: driver.vehicleModel || "",
    licensePlate: driver.licensePlate || "",
  };
}

/** Marks an open ride as expired once its window has passed. */
async function settle(ride) {
  if (ride && ride.status === "open" && ride.expiresAt < Date.now()) {
    ride.status = "expired";
    await R.saveRide(ride);
    await redis.zrem(R.keys.open, ride.id);
    if (ride.riderId) await redis.del(R.keys.riderActive(ride.riderId));
  }
  return ride;
}

async function riderView(ride) {
  const view = {
    id: ride.id,
    status: ride.status,
    pickup: ride.pickup,
    dropoff: ride.dropoff,
    distanceKm: ride.distanceKm,
    durationMin: ride.durationMin,
    price: ride.price,
    finalPrice: ride.finalPrice ?? null,
    currency: ride.currency,
    createdAt: ride.createdAt,
    expiresAt: ride.expiresAt,
    offers: [],
    captain: null,
  };
  if (ride.status === "open") {
    const offers = await R.getOffers(ride.id);
    for (const offer of offers) {
      const driver = await auth.getDriver(offer.driverId);
      if (!driver) continue;
      view.offers.push({
        driverId: offer.driverId,
        pct: offer.pct,
        price: offer.price,
        toPickupKm: offer.toPickupKm ?? null,
        expiresAt: offer.expiresAt,
        captain: { name: driver.name || "", vehicleModel: driver.vehicleModel || "" },
      });
    }
    view.offers.sort((a, b) => a.price - b.price);
  }
  if (ride.driverId) view.captain = captainCard(await auth.getDriver(ride.driverId));
  if (ride.driverLocation) view.captainLocation = ride.driverLocation;
  return view;
}

function assignedCaptainView(ride) {
  return {
    id: ride.id,
    status: ride.status,
    pickup: ride.pickup,                 // exact pickup only after accepting
    dropoff: ride.dropoff,
    distanceKm: ride.distanceKm,
    durationMin: ride.durationMin,
    price: ride.finalPrice ?? ride.price,
    currency: ride.currency,
    rider: { name: ride.riderName || "", phone: ride.riderPhone || "" },
    demo: Boolean(ride.demo),
  };
}

function listView(ride, me, here, myOffer) {
  return {
    id: ride.id,
    approxPickup: ride.approxPickup,
    pickupLabel: ride.pickup.label || "",
    dropoff: ride.dropoff,
    price: ride.price,
    counterPrices: ride.counterPercents.map((pct) => ({ pct, price: R.counterPrice(ride.price, pct) })),
    currency: ride.currency,
    distanceKm: ride.distanceKm,
    durationMin: ride.durationMin,
    bearing: ride.bearing,
    expiresAt: ride.expiresAt,
    toPickupKm: here ? +R.distanceKm(here, ride.approxPickup).toFixed(1) : null,
    mine: ride.riderId === me.id,
    demo: Boolean(ride.demo),
    myOffer: myOffer ? { pct: myOffer.pct, price: myOffer.price, expiresAt: myOffer.expiresAt } : null,
  };
}

// ---------------- GET ----------------
async function handleGet(req, res, me) {
  const { id, mine } = req.query || {};

  if (id) {
    const ride = await settle(await R.getRide(String(id)));
    if (!ride) return fail(res, 404, "not-found");
    const admin = auth.isAdminEmail(me.email);
    const asRider = req.query.as === "rider" && (ride.riderId === me.id || admin);
    if (asRider) return res.status(200).json({ success: true, role: "rider", ride: await riderView(ride) });
    if (ride.driverId === me.id && ride.status !== "open") return res.status(200).json({ success: true, role: "captain", ride: assignedCaptainView(ride) });
    if (ride.riderId === me.id || admin) return res.status(200).json({ success: true, role: "rider", ride: await riderView(ride) });
    return fail(res, 403, "forbidden");
  }

  if (mine) {
    const activeId = await redis.get(R.keys.riderActive(me.id));
    const ride = activeId ? await settle(await R.getRide(String(activeId))) : null;
    return res.status(200).json({ success: true, ride: ride && ["open", "assigned"].includes(ride.status) ? await riderView(ride) : null });
  }

  // Captain map: open requests nearby.
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const here = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;

  const activeId = await redis.get(R.keys.driverActive(me.id));
  const active = activeId ? await R.getRide(String(activeId)) : null;
  const activeRide = active && active.status === "assigned" && active.driverId === me.id ? assignedCaptainView(active) : null;

  const now = Date.now();
  await redis.zremrangebyscore(R.keys.open, 0, now - 60 * 60 * 1000);
  const ids = (await redis.zrange(R.keys.open, now - R.DEMO_WINDOW_MS, "+inf", { byScore: true })) || [];
  const recent = ids.slice(-200);
  const raw = recent.length ? await redis.mget(...recent.map(R.keys.ride)) : [];

  const rides = [];
  for (const item of raw) {
    const ride = R.parse(item);
    if (!ride || ride.status !== "open" || ride.expiresAt < now) continue;
    if (here && R.distanceKm(here, ride.approxPickup) > R.SEARCH_RADIUS_KM) continue;
    const myOffer = R.parse(await redis.hget(R.keys.offers(ride.id), me.id));
    rides.push(listView(ride, me, here, myOffer && myOffer.expiresAt > now ? myOffer : null));
  }
  rides.sort((a, b) => (a.toPickupKm ?? 0) - (b.toPickupKm ?? 0));
  res.status(200).json({ success: true, rides: rides.slice(0, 60), activeRide, serverTime: now });
}

// ---------------- POST ----------------
async function estimate(body, res) {
  const pickup = R.cleanPoint(body.pickup);
  const dropoff = R.cleanPoint(body.dropoff);
  if (!pickup || !dropoff) return fail(res, 400, "invalid-points");
  if (R.distanceKm(pickup, dropoff) > 300) return fail(res, 400, "too-far");
  const pricing = await R.readPricing();
  const route = await R.routeEstimate(pickup, dropoff);
  const price = R.fareFor(pricing, route.distanceKm, route.durationMin);
  return { pickup, dropoff, pricing, route, price };
}

async function create(me, body, res) {
  const rate = await redis.incr(R.keys.createRate(me.id));
  if (rate === 1) await redis.expire(R.keys.createRate(me.id), 3600);
  if (rate > R.MAX_CREATES_PER_HOUR) return fail(res, 429, "too-many-requests");

  const activeId = await redis.get(R.keys.riderActive(me.id));
  if (activeId) {
    const active = await settle(await R.getRide(String(activeId)));
    if (active && ["open", "assigned"].includes(active.status)) {
      return res.status(409).json({ success: false, error: "active-ride", ride: await riderView(active) });
    }
  }

  const est = await estimate(body, res);
  if (!est) return;
  const now = Date.now();
  const id = R.newId();
  const ride = {
    id,
    status: "open",
    riderId: me.id,
    riderName: me.name || "",
    riderPhone: me.phone || "",
    pickup: est.pickup,
    dropoff: est.dropoff,
    approxPickup: R.approximate(est.pickup, id),
    distanceKm: est.route.distanceKm,
    durationMin: est.route.durationMin,
    routeSource: est.route.source,
    bearing: R.bearing(est.pickup, est.dropoff),
    price: est.price,
    counterPercents: est.pricing.counterPercents,
    currency: est.pricing.currency,
    createdAt: now,
    expiresAt: now + R.OPEN_WINDOW_MS,
  };
  await R.saveRide(ride);
  await redis.zadd(R.keys.open, { score: now, member: id });
  await redis.set(R.keys.riderActive(me.id), id, { ex: R.RIDE_TTL_SECONDS });
  res.status(200).json({ success: true, ride: await riderView(ride) });
}

/** Gives the ride to a captain. Only the first caller wins (atomic lock). */
async function assign(ride, driverId, price, location) {
  const locked = await redis.set(R.keys.assign(ride.id), driverId, { nx: true, ex: R.RIDE_TTL_SECONDS });
  if (locked !== "OK") return "taken";
  const fresh = await settle(await R.getRide(ride.id));
  if (!fresh || fresh.status !== "open") {
    await redis.del(R.keys.assign(ride.id));
    return "not-available";
  }
  fresh.status = "assigned";
  fresh.driverId = driverId;
  fresh.finalPrice = price;
  fresh.acceptedAt = Date.now();
  if (location) fresh.driverLocation = location;
  await R.saveRide(fresh);
  await redis.zrem(R.keys.open, fresh.id);
  await redis.del(R.keys.offers(fresh.id));
  await redis.set(R.keys.driverActive(driverId), fresh.id, { ex: R.RIDE_TTL_SECONDS });
  return fresh;
}

async function accept(me, body, res) {
  const ride = await settle(await R.getRide(String(body.id || "")));
  if (!ride || ride.status !== "open") return fail(res, 409, "not-available");
  if (ride.riderId === me.id && !auth.isAdminEmail(me.email)) return fail(res, 400, "own-ride");
  if (!me.name) return fail(res, 400, "profile-incomplete");

  const busyId = await redis.get(R.keys.driverActive(me.id));
  if (busyId) {
    const busy = await R.getRide(String(busyId));
    if (busy && busy.status === "assigned" && busy.driverId === me.id) return fail(res, 409, "busy");
  }

  const lat = Number(body.lat);
  const lng = Number(body.lng);
  const location = Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, at: Date.now() } : null;
  const pct = Number(body.pct) || 0;

  if (pct === 0) {
    const result = await assign(ride, me.id, ride.price, location);
    if (typeof result === "string") return fail(res, 409, result);
    return res.status(200).json({ success: true, ride: assignedCaptainView(result) });
  }

  if (!ride.counterPercents.includes(pct)) return fail(res, 400, "invalid-offer");
  const offer = {
    driverId: me.id,
    pct,
    price: R.counterPrice(ride.price, pct),
    toPickupKm: location ? +R.distanceKm(location, ride.pickup).toFixed(1) : null,
    location,
    at: Date.now(),
    expiresAt: Math.min(Date.now() + R.OFFER_WINDOW_MS, ride.expiresAt),
  };
  await redis.hset(R.keys.offers(ride.id), { [me.id]: JSON.stringify(offer) });
  await redis.expire(R.keys.offers(ride.id), 60 * 30);
  res.status(200).json({ success: true, offer: { pct: offer.pct, price: offer.price, expiresAt: offer.expiresAt } });
}

async function selectOffer(me, body, res) {
  const ride = await settle(await R.getRide(String(body.id || "")));
  if (!ride || ride.riderId !== me.id) return fail(res, 404, "not-found");
  if (ride.status !== "open") return fail(res, 409, "not-available");
  const offer = R.parse(await redis.hget(R.keys.offers(ride.id), String(body.driverId || "")));
  if (!offer || offer.expiresAt < Date.now()) return fail(res, 409, "offer-expired");
  const result = await assign(ride, offer.driverId, offer.price, offer.location);
  if (typeof result === "string") return fail(res, 409, result);
  res.status(200).json({ success: true, ride: await riderView(result) });
}

async function cancel(me, body, res) {
  const ride = await R.getRide(String(body.id || ""));
  if (!ride) return fail(res, 404, "not-found");

  if (ride.riderId === me.id && ["open", "assigned"].includes(ride.status)) {
    ride.status = "cancelled";
    ride.cancelledBy = "rider";
    await R.saveRide(ride);
    await redis.zrem(R.keys.open, ride.id);
    await redis.del(R.keys.riderActive(me.id), R.keys.offers(ride.id));
    if (ride.driverId) await redis.del(R.keys.driverActive(ride.driverId));
    return res.status(200).json({ success: true });
  }

  if (ride.driverId === me.id && ride.status === "assigned") {
    // The captain backs out: the request goes back on the map for others.
    const now = Date.now();
    ride.status = "open";
    ride.declinedBy = [...(ride.declinedBy || []), me.id];
    delete ride.driverId;
    delete ride.finalPrice;
    delete ride.driverLocation;
    ride.expiresAt = now + R.OPEN_WINDOW_MS;
    await R.saveRide(ride);
    await redis.del(R.keys.assign(ride.id), R.keys.driverActive(me.id));
    await redis.zadd(R.keys.open, { score: now, member: ride.id });
    return res.status(200).json({ success: true });
  }
  return fail(res, 403, "forbidden");
}

async function complete(me, body, res) {
  const ride = await R.getRide(String(body.id || ""));
  if (!ride || ride.driverId !== me.id || ride.status !== "assigned") return fail(res, 409, "not-available");
  ride.status = "completed";
  ride.completedAt = Date.now();
  await R.saveRide(ride);
  await redis.del(R.keys.driverActive(me.id));
  if (ride.riderId) await redis.del(R.keys.riderActive(ride.riderId));
  res.status(200).json({ success: true });
}

const DEMO_PLACES = ["حي الملقا", "حي النخيل", "حي العليا", "حي الياسمين", "حي الصحافة", "حي الربيع", "حي السليمانية", "حي الورود", "حي قرطبة", "حي الروضة"];

async function demo(me, body, res) {
  if (!auth.isAdminEmail(me.email)) return fail(res, 403, "forbidden");
  const center = R.cleanPoint({ lat: body.lat, lng: body.lng });
  if (!center) return fail(res, 400, "invalid-points");
  const count = Math.min(Math.max(Number(body.count) || 8, 1), 15);
  const pricing = await R.readPricing();
  const now = Date.now();
  const made = [];
  for (let i = 0; i < count; i++) {
    const at = (km, angle) => ({
      lat: center.lat + (km * Math.cos(angle)) / 111.32,
      lng: center.lng + (km * Math.sin(angle)) / (111.32 * Math.cos((center.lat * Math.PI) / 180)),
    });
    const pickup = { ...at(0.4 + Math.random() * 4, Math.random() * 2 * Math.PI), label: DEMO_PLACES[i % DEMO_PLACES.length] };
    const tripKm = 3 + Math.random() * 18;
    const drop = at(tripKm, Math.random() * 2 * Math.PI);
    const dropoff = { lat: pickup.lat + (drop.lat - center.lat), lng: pickup.lng + (drop.lng - center.lng), label: DEMO_PLACES[(i + 3) % DEMO_PLACES.length] };
    const road = +(R.distanceKm(pickup, dropoff) * 1.3).toFixed(1);
    const minutes = Math.max(3, Math.round((road / 32) * 60));
    const id = R.newId();
    const ride = {
      id,
      status: "open",
      demo: true,
      riderId: `demo-${me.id}`,
      riderName: "راكب تجريبي",
      riderPhone: "",
      pickup: { lat: +pickup.lat.toFixed(6), lng: +pickup.lng.toFixed(6), label: pickup.label },
      dropoff: { lat: +dropoff.lat.toFixed(6), lng: +dropoff.lng.toFixed(6), label: dropoff.label },
      distanceKm: road,
      durationMin: minutes,
      routeSource: "demo",
      price: R.fareFor(pricing, road, minutes),
      counterPercents: pricing.counterPercents,
      currency: pricing.currency,
      createdAt: now,
      expiresAt: now + R.DEMO_WINDOW_MS,
    };
    ride.approxPickup = R.approximate(ride.pickup, id);
    ride.bearing = R.bearing(ride.pickup, ride.dropoff);
    await R.saveRide(ride);
    await redis.zadd(R.keys.open, { score: now, member: id });
    made.push(id);
  }
  res.status(200).json({ success: true, created: made.length });
}

async function setPricing(me, body, res) {
  if (!auth.isAdminEmail(me.email)) return fail(res, 403, "forbidden");
  const p = body.pricing || {};
  const num = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? n : null;
  };
  const next = {
    baseFare: num(p.baseFare, 0, 500),
    perKm: num(p.perKm, 0, 50),
    perMinute: num(p.perMinute, 0, 20),
    minFare: num(p.minFare, 0, 1000),
  };
  if (Object.values(next).some((v) => v === null)) return fail(res, 400, "invalid-pricing");
  const percents = Array.isArray(p.counterPercents) ? p.counterPercents.map(Number).filter((n) => Number.isInteger(n) && n > 0 && n <= 100).slice(0, 3) : R.PRICING_DEFAULTS.counterPercents;
  const saved = { ...next, counterPercents: percents.length ? percents : R.PRICING_DEFAULTS.counterPercents };
  await redis.set(R.keys.pricing, JSON.stringify(saved));
  res.status(200).json({ success: true, pricing: await R.readPricing() });
}

module.exports = async function handler(req, res) {
  if (handlePreflight(req, res)) return;
  withCors(res);
  res.setHeader("Cache-Control", "no-store");
  try {
    const me = await auth.requireDriver(req, res);
    if (!me) return;
    if (!(await allowed(me))) return fail(res, 403, "feature-off");

    if (req.method === "GET") return await handleGet(req, res, me);
    if (req.method !== "POST") return fail(res, 405, "method-not-allowed");

    const body = req.body || {};
    switch (body.action) {
      case "estimate": {
        const est = await estimate(body, res);
        if (!est) return;
        return res.status(200).json({
          success: true,
          price: est.price,
          currency: est.pricing.currency,
          distanceKm: est.route.distanceKm,
          durationMin: est.route.durationMin,
          source: est.route.source,
          counterPercents: est.pricing.counterPercents,
        });
      }
      case "create": return await create(me, body, res);
      case "accept": return await accept(me, body, res);
      case "select-offer": return await selectOffer(me, body, res);
      case "cancel": return await cancel(me, body, res);
      case "complete": return await complete(me, body, res);
      case "demo": return await demo(me, body, res);
      case "pricing": return await setPricing(me, body, res);
      default: return fail(res, 400, "unknown-action");
    }
  } catch (error) {
    console.error("rides", error);
    fail(res, 500, "server-error");
  }
};
