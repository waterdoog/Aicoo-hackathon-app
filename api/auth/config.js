const { send } = require("../_aicoo");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "Method not allowed" });
  send(res, 200, {
    ok: true,
    clientId: process.env.AICOO_CLIENT_ID ? process.env.AICOO_CLIENT_ID.trim() : "",
    redirectUri: process.env.AICOO_REDIRECT_URI ? process.env.AICOO_REDIRECT_URI.trim() : "http://localhost:3000/",
    issuer: process.env.AICOO_ISSUER ? process.env.AICOO_ISSUER.trim() : "https://www.aicoo.io"
  });
};
