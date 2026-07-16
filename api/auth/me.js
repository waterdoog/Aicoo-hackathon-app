const { send, sendError } = require("../_aicoo");
const { fetchUserInfo } = require("./_oauth");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const authHeader = req.headers.authorization || "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : "";
    if (!token) return send(res, 401, { ok: false, error: "Missing access token" });

    const user = await fetchUserInfo(token);
    if (!user || !user.id) {
      return send(res, 401, { ok: false, error: "Session expired" });
    }
    send(res, 200, { ok: true, user });
  } catch (error) {
    sendError(res, error);
  }
};
