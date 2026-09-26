function withCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  return res;
}

function handlePreflight(req, res) {
  if (req.method === "OPTIONS") {
    withCors(res).status(204).end();
    return true;
  }
  return false;
}

module.exports = { withCors, handlePreflight };
