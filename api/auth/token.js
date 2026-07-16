const { send, sendError, readBody } = require("../_aicoo");
const { clientConfig, exchangeToken, fetchUserInfo } = require("./_oauth");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const { code, codeVerifier } = await readBody(req);
    if (!code || !codeVerifier) {
      return send(res, 400, { ok: false, error: "Missing code or codeVerifier" });
    }

    const result = await exchangeToken({
      grant_type: "authorization_code",
      code,
      redirect_uri: clientConfig().redirectUri,
      code_verifier: codeVerifier,
    });
    if (!result.ok) {
      return send(res, result.status, { ok: false, error: result.error, details: result.details || null });
    }

    const user = (await fetchUserInfo(result.accessToken)) || {};
    send(res, 200, {
      ok: true,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      user,
    });
  } catch (error) {
    sendError(res, error);
  }
};
