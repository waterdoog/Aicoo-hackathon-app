const { send } = require("../_aicoo");
const { clientConfig } = require("./_oauth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "Method not allowed" });
  const { clientId, redirectUri, issuer } = clientConfig();
  send(res, 200, { ok: true, clientId, redirectUri, issuer });
};
