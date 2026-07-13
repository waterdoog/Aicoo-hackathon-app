const { send, sendError, readBody } = require("../_aicoo");

function firstValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizeUserInfo(data) {
  const profile = data?.user || data?.profile || data?.data?.user || data?.data || data || {};
  const firstName = firstValue(profile, ["given_name", "firstName", "first_name"]);
  const lastName = firstValue(profile, ["family_name", "lastName", "last_name"]);
  const name = firstValue(profile, ["name", "displayName", "username"]) || [firstName, lastName].filter(Boolean).join(" ");
  return {
    id: firstValue(profile, ["sub", "id", "userId"]),
    name,
    email: firstValue(profile, ["email", "mail"]),
    picture: firstValue(profile, ["picture", "avatar", "image", "avatarUrl"]),
    title: firstValue(profile, ["title", "role", "headline", "jobTitle"]),
    company: firstValue(profile, ["company", "organization", "org", "school"]),
    timezone: firstValue(profile, ["timezone", "timeZone"]),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { ok: false, error: "Method not allowed" });

  try {
    const { code, codeVerifier } = await readBody(req);
    if (!code || !codeVerifier) {
      return send(res, 400, { ok: false, error: "Missing code or codeVerifier" });
    }

    const clientId = process.env.AICOO_CLIENT_ID ? process.env.AICOO_CLIENT_ID.trim() : "";
    const clientSecret = process.env.AICOO_CLIENT_SECRET ? process.env.AICOO_CLIENT_SECRET.trim() : "";
    const redirectUri = process.env.AICOO_REDIRECT_URI ? process.env.AICOO_REDIRECT_URI.trim() : "http://localhost:3000/";
    const issuer = process.env.AICOO_ISSUER ? process.env.AICOO_ISSUER.trim() : "https://www.aicoo.io";

    if (!clientId || !clientSecret) {
      return send(res, 500, { ok: false, error: "AICOO_CLIENT_ID or AICOO_CLIENT_SECRET not configured on the server." });
    }

    // Exchange authorization code for token
    const tokenUrl = `${issuer}/api/auth/oauth2/token`;
    const bodyParams = new URLSearchParams();
    bodyParams.append("grant_type", "authorization_code");
    bodyParams.append("code", code);
    bodyParams.append("redirect_uri", redirectUri);
    bodyParams.append("client_id", clientId);
    bodyParams.append("client_secret", clientSecret);
    bodyParams.append("code_verifier", codeVerifier);

    const tokenRes = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: bodyParams.toString(),
    });

    const tokenData = await tokenRes.json();

    if (!tokenRes.ok) {
      return send(res, tokenRes.status, {
        ok: false,
        error: tokenData.error || "Failed to exchange authorization code.",
        details: tokenData,
      });
    }

    const accessToken = tokenData.access_token;

    // Fetch user profile info
    const userInfoUrl = `${issuer}/api/auth/oauth2/userinfo`;
    const userRes = await fetch(userInfoUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    let userData = {};
    if (userRes.ok) {
      userData = normalizeUserInfo(await userRes.json());
    }

    send(res, 200, {
      ok: true,
      accessToken,
      user: userData,
    });
  } catch (error) {
    sendError(res, error);
  }
};
