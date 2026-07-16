const { send, sendError, readBody } = require("../_aicoo");
const { exchangeToken, fetchUserInfo } = require("./_oauth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const { refreshToken } = await readBody(req);
    if (!refreshToken) {
      return send(res, 400, { ok: false, error: "Missing refreshToken" });
    }

    const result = await exchangeToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    if (!result.ok) {
      // A dead refresh token means the session is over; 401 tells the client to sign in again.
      const status = result.status >= 500 ? result.status : 401;
      return send(res, status, { ok: false, error: result.error, details: result.details || null });
    }

    const user = (await fetchUserInfo(result.accessToken)) || null;
    send(res, 200, {
      ok: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken || refreshToken,
      expiresIn: result.expiresIn,
      user,
    });
  } catch (error) {
    sendError(res, error);
  }
};
