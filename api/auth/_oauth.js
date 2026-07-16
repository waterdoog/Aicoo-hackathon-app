const ISSUER = (process.env.AICOO_ISSUER || "https://www.aicoo.io").trim().replace(/\/$/, "");

function clientConfig() {
  return {
    issuer: ISSUER,
    clientId: (process.env.AICOO_CLIENT_ID || "").trim(),
    clientSecret: (process.env.AICOO_CLIENT_SECRET || "").trim(),
    redirectUri: (process.env.AICOO_REDIRECT_URI || "http://localhost:3000/").trim(),
  };
}

function firstValue(source, keys) {
  for (const key of keys) {
    const value = source?.[key];
    if (value !== undefined && value !== null && String(value).trim()) return String(value).trim();
  }
  return "";
}

function normalizeUserInfo(profile) {
  const name =
    firstValue(profile, ["name"]) ||
    [profile?.given_name, profile?.family_name].filter(Boolean).join(" ").trim();
  return {
    id: firstValue(profile, ["sub", "id"]),
    name: name || firstValue(profile, ["email"]).split("@")[0],
    email: firstValue(profile, ["email"]),
    picture: firstValue(profile, ["picture"]),
  };
}

async function exchangeToken(params) {
  const { issuer, clientId, clientSecret } = clientConfig();
  if (!clientId || !clientSecret) {
    return { ok: false, status: 500, error: "AICOO_CLIENT_ID or AICOO_CLIENT_SECRET not configured on the server." };
  }
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params });
  const response = await fetch(`${issuer}/api/auth/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.access_token) {
    return {
      ok: false,
      status: response.status || 502,
      error: data.error_description || data.error || "Aicoo token request failed.",
      details: data,
    };
  }
  return {
    ok: true,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresIn: Number(data.expires_in) || 900,
  };
}

async function fetchUserInfo(accessToken) {
  const { issuer } = clientConfig();
  const response = await fetch(`${issuer}/api/auth/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) return null;
  return normalizeUserInfo(await response.json().catch(() => ({})));
}

module.exports = { clientConfig, exchangeToken, fetchUserInfo, normalizeUserInfo };
