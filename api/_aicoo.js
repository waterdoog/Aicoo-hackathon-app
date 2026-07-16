const AICOO_OS_BASE_URL = "https://www.aicoo.io/api/v1";
const AICOO_APP_BASE_URL = "https://www.aicoo.io";
const db = require("../lib/db");

const MARKERS = {
  event: "AICOO_EVENT_RECORD",
  participant: "AICOO_PARTICIPANT_RECORD",
  project: "AICOO_PROJECT_RECORD",
};

const EVENT_SUBSQUARE_PATTERN = /hack|event|summit|demo-day|jam|conf/i;
const MAX_SQUARE_PAGES = 4;
const SQUARE_PAGE_LIMIT = 50;

class AicooError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function apiKey() {
  return (process.env.AICOO_API_KEY || process.env.PULSE_API_KEY || "").trim();
}

function getAuthToken(req) {
  if (!req || !req.headers) return null;
  const authHeader = req.headers.authorization || req.headers.Authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.substring(7).trim() || null;
  }
  return null;
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function encodeRecord(data) {
  return Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
}

function decodeRecord(value) {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

function recordLine(marker, data) {
  return `${marker} ${encodeRecord(data)}`;
}

// Aicoo access tokens are only valid for the requesting user; API-key fallback
// would attribute writes to the key owner, so writes are strictly user-token.
async function authedFetch(req, url, options = {}) {
  const { auth = "server", ...fetchOptions } = options;
  const token = getAuthToken(req);
  const key = auth === "user" ? token : token || apiKey();
  if (!key) {
    throw new AicooError(
      auth === "user"
        ? "Sign in with Aicoo to continue."
        : "Aicoo API is not reachable: the server is missing AICOO_API_KEY.",
      401
    );
  }

  const doFetch = async (authKey) => {
    const response = await fetch(url, {
      ...fetchOptions,
      headers: {
        Authorization: `Bearer ${authKey}`,
        "Content-Type": "application/json",
        ...(fetchOptions.headers || {}),
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    return { response, data };
  };

  let { response, data } = await doFetch(key);
  // Public reads may retry with the server key when a stale user token expires.
  const method = (fetchOptions.method || "GET").toUpperCase();
  if (!response.ok && response.status === 401 && auth !== "user" && method === "GET" && token && apiKey() && token !== apiKey()) {
    ({ response, data } = await doFetch(apiKey()));
  }

  if (!response.ok) {
    const message =
      typeof data === "object" && (data?.message || data?.error)
        ? data.message || data.error
        : `Aicoo API request failed: ${response.status}`;
    throw new AicooError(message, response.status, typeof data === "object" ? data : null);
  }
  return data;
}

async function aicooFetch(req, path, options = {}) {
  return authedFetch(req, `${AICOO_OS_BASE_URL}${path}`, options);
}

async function squareFetch(req, path, options = {}) {
  return authedFetch(req, `${AICOO_APP_BASE_URL}/api/square${path}`, options);
}

async function fetchUserInfo(req) {
  const token = getAuthToken(req);
  if (!token) throw new AicooError("Sign in with Aicoo to continue.", 401);
  const response = await fetch(`${AICOO_APP_BASE_URL}/api/auth/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    throw new AicooError("Your Aicoo session has expired. Please sign in again.", 401);
  }
  const profile = await response.json();
  const id = String(profile.sub || "").trim();
  if (!id) throw new AicooError("Aicoo did not return a user identity.", 401);
  return {
    id,
    name:
      String(profile.name || "").trim() ||
      [profile.given_name, profile.family_name].filter(Boolean).join(" ").trim() ||
      String(profile.email || "").split("@")[0] ||
      "Aicoo user",
    email: String(profile.email || "").trim(),
    picture: String(profile.picture || "").trim(),
  };
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function sendError(res, error) {
  send(res, error.status || 500, {
    ok: false,
    error: error.message || "Unexpected server error",
    details: error.details || null,
  });
}

async function readBody(req) {
  // Vercel's Node helpers may pre-consume the stream and expose req.body.
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "string") return req.body ? JSON.parse(req.body) : {};
    if (Buffer.isBuffer(req.body)) {
      const raw = req.body.toString("utf8");
      return raw ? JSON.parse(raw) : {};
    }
    return req.body;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function firstId(...values) {
  return values.find((value) => value === 0 || value) ?? null;
}

function firstLine(value) {
  const line = String(value || "")
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find(Boolean) || "";
  return line.replace(/^[#>*\-\s]+/, "");
}

function truncate(value, length) {
  const text = String(value || "").trim();
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function cleanText(value, max) {
  return truncate(String(value || "").replace(/\s+/g, " ").trim(), max);
}

function cleanUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    const parsed = new URL(text.includes("://") ? text : `https://${text}`);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return "";
    return parsed.toString();
  } catch {
    return "";
  }
}

function cleanList(value, maxItems, maxLength) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return source
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function agentUrlFromToken(token) {
  return token ? `${AICOO_APP_BASE_URL}/a/${token}` : "";
}

function extractShareLink(data) {
  const link = data?.shareLink || data?.link || (typeof data?.url === "string" ? data : null) || {};
  const token = typeof link.token === "string" ? link.token : "";
  const url = typeof link.url === "string" && link.url ? link.url : agentUrlFromToken(token);
  return { url, token };
}

function extractFirstRecordFromText(text, marker) {
  const pattern = new RegExp(`${marker}\\s+([A-Za-z0-9_-]+)`);
  const match = String(text || "").match(pattern);
  if (!match) return null;
  try {
    return decodeRecord(match[1]);
  } catch {
    return null;
  }
}

function postHasTag(post, tag) {
  return Array.isArray(post.tags) && post.tags.includes(tag);
}

function linkFromText(text) {
  const match = String(text || "").match(/https?:\/\/\S+/);
  return match ? match[0].replace(/[),.;]+$/, "") : "";
}

function labeledUrl(text, labels) {
  const source = String(text || "");
  for (const label of labels) {
    const pattern = new RegExp(`${label}\\s*(?:url|link)?\\s*[:：-]\\s*(https?:\\/\\/\\S+)`, "i");
    const match = source.match(pattern);
    if (match) return match[1].replace(/[),.;]+$/, "");
  }
  for (const label of labels) {
    const pattern = new RegExp(`${label}[^\\n]{0,90}?(https?:\\/\\/\\S+)`, "i");
    const match = source.match(pattern);
    if (match) return match[1].replace(/[),.;]+$/, "");
  }
  return "";
}

function hasMarker(post, marker) {
  return Boolean(extractFirstRecordFromText(post.content, marker));
}

function hasProjectSignal(post) {
  const text = `${post.title || ""}\n${post.content || ""}`;
  return (
    postHasTag(post, "aicoo-project") ||
    hasMarker(post, MARKERS.project) ||
    /(^|\n)\s*project\s*name\s*[:：]/i.test(text) ||
    /(^|\n)\s*(github|demo|live\s+demo|video\s+demo|built\s+with\s+aicoo)\s*[:：]/i.test(text) ||
    /\b(live\s+demo|video\s+demo|github\s+repo)\b/i.test(text) ||
    /\bsubmission\b/i.test(post.title || "")
  );
}

function hasParticipantSignal(post) {
  const text = `${post.title || ""}\n${post.content || ""}`;
  return (
    postHasTag(post, "aicoo-participant") ||
    hasMarker(post, MARKERS.participant) ||
    /(^|\n)\s*(short\s+intro|skills|looking\s+for|role|company)\s*[:：#]/i.test(text) ||
    /\b(matchmaking|participant|looking for team)\b/i.test(text)
  );
}

function postOwnerName(post) {
  return (
    post.ownerName ||
    [post.firstName, post.lastName].filter(Boolean).join(" ") ||
    post.username ||
    "Aicoo member"
  );
}

function squarePostUrl(post) {
  return post?.id ? `${AICOO_APP_BASE_URL}/square/p/${post.id}` : "";
}

function mapPostToParticipant(post, slug) {
  const record = extractFirstRecordFromText(post.content, MARKERS.participant);
  const fromPost = {
    avatarUrl: post.avatarUrl || "",
    agentName: post.agentName || "",
    squarePostUrl: squarePostUrl(post),
    likeCount: post.likeCount || 0,
    askCount: post.askCount || 0,
  };
  if (record) {
    return {
      ...record,
      ...fromPost,
      sharedAgentLink: agentUrlFromToken(post.agentLinkToken) || record.sharedAgentLink || "",
      sourcePostId: post.id,
      createdAt: record.createdAt || post.createdAt,
    };
  }
  return {
    id: `square-${post.id}`,
    eventSlug: slug,
    name: postOwnerName(post),
    role: post.headline || "Participant",
    company: "",
    timezone: "",
    intro: post.content || "",
    skills: post.tags || [],
    lookingForTeam: false,
    lookingFor: [],
    agentName: post.agentName || "",
    sharedAgentLink: agentUrlFromToken(post.agentLinkToken) || linkFromText(post.content),
    ...fromPost,
    sourcePostId: post.id,
    createdAt: post.createdAt,
  };
}

function mapPostToProject(post, slug) {
  const record = extractFirstRecordFromText(post.content, MARKERS.project);
  const fromPost = {
    squarePostUrl: squarePostUrl(post),
    likeCount: post.likeCount || 0,
    commentCount: post.commentCount || 0,
  };
  if (record) {
    return {
      ...record,
      ...fromPost,
      sharedProjectAgentLink: agentUrlFromToken(post.agentLinkToken) || record.sharedProjectAgentLink || "",
      sourcePostId: post.id,
      createdAt: record.createdAt || post.createdAt,
    };
  }
  return {
    id: `square-${post.id}`,
    eventSlug: slug,
    projectName: post.title,
    oneLiner: truncate(firstLine(post.content), 140),
    description: post.content || "",
    track: "",
    authors: [postOwnerName(post)],
    githubUrl: labeledUrl(post.content, ["github", "repo", "github repo"]),
    demoUrl: labeledUrl(post.content, ["live demo", "demo"]),
    videoUrl: labeledUrl(post.content, ["video demo", "video"]),
    aicooUsage: "",
    projectAgentName: post.agentName || "",
    sharedProjectAgentLink: agentUrlFromToken(post.agentLinkToken) || labeledUrl(post.content, ["chat with project agent", "project agent"]),
    ...fromPost,
    sourcePostId: post.id,
    createdAt: post.createdAt,
  };
}

function mergeBySource(primary, secondary) {
  const seenPosts = new Set();
  const seenIds = new Set();
  const result = [];
  for (const item of [...primary, ...secondary]) {
    const postKey = item.sourcePostId ? `post:${item.sourcePostId}` : "";
    const idKey = item.id ? `id:${item.id}` : "";
    if ((postKey && seenPosts.has(postKey)) || (idKey && seenIds.has(idKey))) continue;
    if (postKey) seenPosts.add(postKey);
    if (idKey) seenIds.add(idKey);
    result.push(item);
  }
  return result;
}

function aicooUnavailable(error) {
  return {
    status: error.status || 500,
    message: error.message || "Aicoo sync failed",
  };
}

function sortByCreatedAtDesc(items) {
  return items.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

function sanitizeEvent(event) {
  const { accessCode, inviteToken, ...rest } = event;
  return { ...rest, isProtected: Boolean(accessCode || inviteToken) };
}

async function listSquarePosts(req, slug) {
  const posts = [];
  for (let page = 0; page < MAX_SQUARE_PAGES; page += 1) {
    const data = await squareFetch(
      req,
      `?subsquare=${encodeURIComponent(slug)}&limit=${SQUARE_PAGE_LIMIT}&offset=${page * SQUARE_PAGE_LIMIT}`
    );
    const batch = data.posts || [];
    posts.push(...batch);
    if (!data.hasMore || batch.length < SQUARE_PAGE_LIMIT) break;
  }
  return posts;
}

async function publishSquarePost(req, { subsquare, title, content, tags = [], agentLinkToken = "" }) {
  const body = {
    subsquare,
    title: truncate(title, 200),
    content,
    tags: tags.filter(Boolean).slice(0, 10),
    agentLinkToken: agentLinkToken || undefined,
    reachability: agentLinkToken ? "open" : "closed",
  };
  const data = await squareFetch(req, "", {
    auth: "user",
    method: "POST",
    body: JSON.stringify(body),
  });
  return data.post || data;
}

async function updateSquarePost(req, postId, { title, content, tags = [], agentLinkToken = "" }) {
  const body = {
    title: truncate(title, 200),
    content,
    tags: tags.filter(Boolean).slice(0, 10),
    agentLinkToken: agentLinkToken || undefined,
    reachability: agentLinkToken ? "open" : "closed",
  };
  const data = await squareFetch(req, `/${postId}`, {
    auth: "user",
    method: "PATCH",
    body: JSON.stringify(body),
  });
  return data.post || data;
}

async function checkAicooStatus(req) {
  await aicooFetch(req, "/init", { method: "POST", body: "{}" });
  return aicooFetch(req, "/os/status");
}

async function createFolder(req, path) {
  const data = await aicooFetch(req, "/os/folders", {
    auth: "user",
    method: "POST",
    body: JSON.stringify({ path }),
  });
  const folder = data.folder || data.data?.folder || data;
  return { id: firstId(folder?.id, data.folderId, data.id), raw: data };
}

async function createNote(req, { title, content, folderId, tags = [] }) {
  return aicooFetch(req, "/os/notes", {
    auth: "user",
    method: "POST",
    body: JSON.stringify({ title, content, folderId, tags }),
  });
}

async function upsertContextNote(req, { noteId, title, content, folderId, tags = [] }) {
  if (noteId) {
    try {
      await aicooFetch(req, `/os/notes/${noteId}`, {
        auth: "user",
        method: "PATCH",
        body: JSON.stringify({ title, content }),
      });
      return noteId;
    } catch {
      // Fall through and create a fresh note if the old one is gone or immutable.
    }
  }
  const data = await createNote(req, { title, content, folderId, tags });
  return firstId(data?.result?.note?.id, data?.note?.id, data?.result?.uiAction?.action?.noteId);
}

async function createAgentShare(req, { label, folderIds, allowBooking = false }) {
  if (!folderIds?.length || folderIds.some((id) => id == null)) return { url: "", token: "" };
  const data = await aicooFetch(req, "/os/share", {
    auth: "user",
    method: "POST",
    body: JSON.stringify({
      scope: "folders",
      access: allowBooking ? "read_calendar_write" : "read",
      notesAccess: "read",
      folderIds,
      label: truncate(label, 120),
      expiresIn: "never",
      requireSignIn: false,
      identity: { loadCoo: true, loadUser: true, loadPolicy: true },
    }),
  });
  return extractShareLink(data);
}

function mapSubsquareToEvent(item) {
  const slug = item.subsquare || slugify(item.name);
  const name = item.name || `s/${slug}`;
  return {
    id: slug,
    slug,
    name,
    type: "Hackathon",
    visibility: item.isPrivate ? "private" : "public",
    date: item.latestPostAt ? new Date(item.latestPostAt).toISOString().slice(0, 10) : "",
    description: item.description || "Live hackathon feed on Aicoo Square.",
    postCount: item.postCount || 0,
    peopleCount: item.peopleCount || 0,
    latestPostAt: item.latestPostAt || "",
    squareLink: `${AICOO_APP_BASE_URL}/square?subsquare=${encodeURIComponent(slug)}`,
    source: "square",
  };
}

function isEventLikeSubsquare(item) {
  if ((item.subsquare || "") === "events") return false; // meta feed of announcements, not an event
  return EVENT_SUBSQUARE_PATTERN.test(`${item.subsquare || ""} ${item.name || ""}`);
}

function isEventAnnouncement(post) {
  return hasMarker(post, MARKERS.event) || postHasTag(post, "aicoo-event");
}

async function listEvents(req) {
  const dbEvents = await db.listEvents();
  let squareEvents = [];
  let squareError = null;
  try {
    const data = await squareFetch(req, "/subsquares");
    squareEvents = (data.subsquares || []).filter(isEventLikeSubsquare).map(mapSubsquareToEvent);
  } catch (error) {
    squareError = error;
  }
  if (squareError && !db.hasDatabase()) throw squareError;
  const dbSlugs = new Set(dbEvents.map((event) => event.slug));
  const merged = [...dbEvents, ...squareEvents.filter((event) => !dbSlugs.has(event.slug))];
  return sortByCreatedAtDesc(
    merged.map((event) => ({
      ...event,
      latestPostAt: event.latestPostAt || event.createdAt || "",
    }))
  );
}

async function getEvent(req, slug) {
  const events = await listEvents(req);
  return events.find((item) => item.slug === slug) || null;
}

function assertEventAccess(req, event) {
  if (!event) throw new AicooError("Event not found.", 404);
  if (event.visibility !== "private") return;
  const code = String(req.headers["x-event-code"] || "").trim().toLowerCase();
  const expected = [event.accessCode, event.inviteToken]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!expected.length) return;
  if (!code || !expected.includes(code)) {
    throw new AicooError("This event is private. Enter the access code to continue.", 403);
  }
}

async function requireEvent(req, slug) {
  const dbEvent = (await db.listEvents()).find((item) => item.slug === slug);
  if (dbEvent) {
    assertEventAccess(req, dbEvent);
    return dbEvent;
  }
  // Events can also be plain Aicoo subsquares that were never announced here.
  return { slug, name: slug, visibility: "public" };
}

function verifyEventCode(event, input) {
  const provided = String(input.accessCode || input.inviteToken || "").trim().toLowerCase();
  const expected = [event.accessCode, event.inviteToken]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (!expected.length) return true;
  return Boolean(provided) && expected.includes(provided);
}

async function createEvent(req, input) {
  const user = await fetchUserInfo(req);
  const name = cleanText(input.name, 120);
  if (!name) throw new AicooError("Event name is required.", 400);
  const description = String(input.description || "").trim();
  if (!description) throw new AicooError("Event description is required.", 400);
  const slug = slugify(input.slug || name);
  if (!slug) throw new AicooError("Event slug is required.", 400);

  const existing = (await db.listEvents()).find((item) => item.slug === slug);
  if (existing && existing.owner?.userId && existing.owner.userId !== user.id) {
    throw new AicooError("An event with this slug already exists.", 409);
  }

  const folderPath = `Aicoo Events/${slug}`;
  const event = {
    id: slug,
    slug,
    name,
    type: cleanText(input.type, 40) || "Hackathon",
    visibility: input.visibility === "private" ? "private" : "public",
    accessCode: cleanText(input.accessCode, 60),
    date: cleanText(input.date, 80),
    description: truncate(description, 2000),
    owner: { userId: user.id, name: user.name },
    folderId: existing?.folderId || null,
    folderPath,
    squareLink: `${AICOO_APP_BASE_URL}/square?subsquare=${encodeURIComponent(slug)}`,
    contextAgentLink: existing?.contextAgentLink || "",
    sourcePostId: existing?.sourcePostId || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    source: "app",
  };
  if (event.visibility === "private" && !event.accessCode) {
    throw new AicooError("Private events need an access code.", 400);
  }

  try {
    if (!event.folderId) {
      const folder = await createFolder(req, folderPath);
      event.folderId = folder.id;
    }
    if (!event.contextAgentLink) {
      const share = await createAgentShare(req, {
        label: `${event.name} · Event Context`,
        folderIds: [event.folderId],
      });
      event.contextAgentLink = share.url;
      event.contextAgentToken = share.token;
    }
    event.contextNoteId = await upsertContextNote(req, {
      noteId: existing?.contextNoteId || null,
      folderId: event.folderId,
      title: `[Aicoo Event] ${event.name}`,
      tags: ["aicoo-event", event.visibility],
      content: [
        recordLine(MARKERS.event, sanitizeEvent(event)),
        "",
        `# ${event.name}`,
        "",
        event.description,
        "",
        event.date ? `Date: ${event.date}` : "",
        `Event feed: ${event.squareLink}`,
      ].filter(Boolean).join("\n"),
    });

    const postPayload = {
      subsquare: "events",
      title: `[Event] ${event.name}`,
      tags: ["aicoo-event", event.type.toLowerCase(), event.visibility],
      agentLinkToken: event.contextAgentToken || "",
      content: [
        recordLine(MARKERS.event, sanitizeEvent(event)),
        "",
        event.description,
        "",
        event.date ? `Date: ${event.date}` : "",
        `Live feed: ${event.squareLink}`,
      ].filter(Boolean).join("\n"),
    };
    if (event.sourcePostId) {
      try {
        await updateSquarePost(req, event.sourcePostId, postPayload);
      } catch {
        const post = await publishSquarePost(req, postPayload);
        event.sourcePostId = post.id;
      }
    } else {
      const post = await publishSquarePost(req, postPayload);
      event.sourcePostId = post.id;
    }
    event.aicooSync = null;
  } catch (error) {
    if (error.status === 401) throw error;
    if (!db.hasDatabase()) throw error;
    event.aicooSync = aicooUnavailable(error);
  }
  await db.saveEvent(event);
  return sanitizeEvent(event);
}

async function listParticipants(req, slug) {
  const event = (await db.listEvents()).find((item) => item.slug === slug);
  if (event) assertEventAccess(req, event);
  const dbParticipants = await db.listParticipants(slug);
  try {
    const posts = await listSquarePosts(req, slug);
    const squareParticipants = posts
      .filter((post) => !isEventAnnouncement(post) && hasParticipantSignal(post) && !hasProjectSignal(post))
      .map((post) => mapPostToParticipant(post, slug));
    return sortByCreatedAtDesc(mergeBySource(dbParticipants, squareParticipants));
  } catch (error) {
    if (db.hasDatabase()) return sortByCreatedAtDesc(dbParticipants);
    throw error;
  }
}

function participantContent(participant) {
  return [
    recordLine(MARKERS.participant, participant),
    "",
    participant.intro,
    "",
    participant.company ? `Company: ${participant.company}` : "",
    participant.timezone ? `Timezone: ${participant.timezone}` : "",
    participant.skills.length ? `Skills: ${participant.skills.join(", ")}` : "",
    participant.lookingFor.length ? `Looking for: ${participant.lookingFor.join(", ")}` : "",
    "",
    participant.sharedAgentLink ? `Chat with ${participant.name}'s agent: ${participant.sharedAgentLink}` : "",
  ].filter(Boolean).join("\n");
}

async function createParticipant(req, slug, input) {
  const user = await fetchUserInfo(req);
  const event = await requireEvent(req, slug);
  const name = cleanText(input.name, 80);
  const role = cleanText(input.role, 80);
  const intro = truncate(String(input.intro || "").trim(), 1200);
  if (!name) throw new AicooError("Name is required.", 400);
  if (!role) throw new AicooError("Role is required.", 400);
  if (!intro) throw new AicooError("A short intro is required.", 400);

  const existing = await db.getParticipant(`${slug}--${user.id}`);
  const participant = {
    id: `${slug}--${user.id}`,
    eventSlug: slug,
    name,
    role,
    company: cleanText(input.company, 80),
    timezone: cleanText(input.timezone, 40),
    intro,
    skills: cleanList(input.skills, 8, 30),
    lookingForTeam: Boolean(input.lookingForTeam),
    lookingFor: cleanList(input.lookingFor, 6, 40),
    agentName: cleanText(input.agentName, 60) || `${name}'s Aicoo Agent`,
    allowBooking: Boolean(input.allowBooking),
    avatarUrl: user.picture || "",
    owner: { userId: user.id, name: user.name },
    folderId: existing?.folderId || null,
    contextNoteId: existing?.contextNoteId || null,
    sharedAgentLink: existing?.sharedAgentLink || "",
    agentLinkToken: existing?.agentLinkToken || "",
    sourcePostId: existing?.sourcePostId || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  // Everything Aicoo-side runs as the signed-in user: their folder, their
  // share link, their Square post. This is what keeps ownership correct.
  if (!participant.folderId) {
    const folder = await createFolder(req, `Aicoo Events/${slug}/people/${slugify(name) || user.id}`);
    participant.folderId = folder.id;
  }
  const bookingChanged = existing && Boolean(existing.allowBooking) !== participant.allowBooking;
  if (!participant.sharedAgentLink || !participant.agentLinkToken || bookingChanged) {
    const share = await createAgentShare(req, {
      label: `${participant.name} · ${event.name || slug}`,
      folderIds: [participant.folderId],
      allowBooking: participant.allowBooking,
    });
    participant.sharedAgentLink = share.url;
    participant.agentLinkToken = share.token;
  }

  participant.contextNoteId = await upsertContextNote(req, {
    noteId: participant.contextNoteId,
    folderId: participant.folderId,
    title: truncate(`[Participant] ${participant.name} · ${event.name || slug}`, 180),
    tags: ["aicoo-participant", slug],
    content: [
      `# ${participant.name}`,
      `Role: ${participant.role}`,
      participant.company ? `Company: ${participant.company}` : "",
      participant.timezone ? `Timezone: ${participant.timezone}` : "",
      "",
      participant.intro,
      "",
      participant.skills.length ? `Skills: ${participant.skills.join(", ")}` : "",
      participant.lookingFor.length ? `Looking for: ${participant.lookingFor.join(", ")}` : "",
      participant.lookingForTeam ? "Currently looking for teammates." : "",
      "",
      `Registered for ${event.name || slug} via Aicoo Events Square.`,
    ].filter(Boolean).join("\n"),
  });

  const postPayload = {
    subsquare: slug,
    title: `[Participant] ${participant.name}${participant.role ? ` · ${participant.role}` : ""}`,
    tags: ["aicoo-participant", "hackathon-participant", ...participant.skills.slice(0, 5).map(slugify)],
    agentLinkToken: participant.agentLinkToken,
    content: participantContent(participant),
  };
  if (participant.sourcePostId) {
    try {
      await updateSquarePost(req, participant.sourcePostId, postPayload);
    } catch {
      const post = await publishSquarePost(req, postPayload);
      participant.sourcePostId = post.id;
    }
  } else {
    const post = await publishSquarePost(req, postPayload);
    participant.sourcePostId = post.id;
  }

  await db.saveParticipant(participant);
  return { participant, updated: Boolean(existing) };
}

async function listProjects(req, slug) {
  const event = (await db.listEvents()).find((item) => item.slug === slug);
  if (event) assertEventAccess(req, event);
  const dbProjects = await db.listProjects(slug);
  try {
    const posts = await listSquarePosts(req, slug);
    // Hackathon feeds default to the submissions board: anything that isn't a
    // participant card or an event announcement reads best as a project post.
    const squareProjects = posts
      .filter((post) => !isEventAnnouncement(post) && (hasProjectSignal(post) || !hasParticipantSignal(post)))
      .map((post) => mapPostToProject(post, slug));
    return sortByCreatedAtDesc(mergeBySource(dbProjects, squareProjects));
  } catch (error) {
    if (db.hasDatabase()) return sortByCreatedAtDesc(dbProjects);
    throw error;
  }
}

function projectContent(project) {
  return [
    recordLine(MARKERS.project, project),
    "",
    project.oneLiner,
    "",
    project.description,
    "",
    project.authors.length ? `Authors: ${project.authors.join(", ")}` : "",
    project.track ? `Track: ${project.track}` : "",
    project.githubUrl ? `GitHub: ${project.githubUrl}` : "",
    project.demoUrl ? `Live demo: ${project.demoUrl}` : "",
    project.videoUrl ? `Video demo: ${project.videoUrl}` : "",
    project.aicooUsage ? `Built with Aicoo: ${project.aicooUsage}` : "",
    "",
    project.sharedProjectAgentLink ? `Chat with project agent: ${project.sharedProjectAgentLink}` : "",
  ].filter(Boolean).join("\n");
}

async function createProject(req, slug, input) {
  const user = await fetchUserInfo(req);
  const event = await requireEvent(req, slug);
  const projectName = cleanText(input.projectName, 120);
  const oneLiner = cleanText(input.oneLiner, 180);
  const description = truncate(String(input.description || "").trim(), 4000);
  if (!projectName) throw new AicooError("Project name is required.", 400);
  if (!oneLiner) throw new AicooError("A one-line intro is required.", 400);
  if (!description) throw new AicooError("Project description is required.", 400);

  const projectKey = slugify(projectName);
  const existing = await db.getProject(`${slug}--${user.id}--${projectKey}`);
  const project = {
    id: `${slug}--${user.id}--${projectKey}`,
    eventSlug: slug,
    projectName,
    oneLiner,
    description,
    track: cleanText(input.track, 60),
    authors: cleanList(input.authors, 8, 60).length ? cleanList(input.authors, 8, 60) : [user.name],
    githubUrl: cleanUrl(input.githubUrl),
    demoUrl: cleanUrl(input.demoUrl),
    videoUrl: cleanUrl(input.videoUrl),
    aicooUsage: truncate(String(input.aicooUsage || "").trim(), 1200),
    projectAgentName: `${projectName} Project Agent`,
    owner: { userId: user.id, name: user.name },
    folderId: existing?.folderId || null,
    contextNoteId: existing?.contextNoteId || null,
    sharedProjectAgentLink: existing?.sharedProjectAgentLink || "",
    agentLinkToken: existing?.agentLinkToken || "",
    sourcePostId: existing?.sourcePostId || null,
    createdAt: existing?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  if (!project.folderId) {
    const folder = await createFolder(req, `Aicoo Events/${slug}/projects/${projectKey || user.id}`);
    project.folderId = folder.id;
  }
  if (!project.sharedProjectAgentLink || !project.agentLinkToken) {
    const share = await createAgentShare(req, {
      label: `${project.projectName} · ${event.name || slug}`,
      folderIds: [project.folderId],
    });
    project.sharedProjectAgentLink = share.url;
    project.agentLinkToken = share.token;
  }

  project.contextNoteId = await upsertContextNote(req, {
    noteId: project.contextNoteId,
    folderId: project.folderId,
    title: truncate(`[Project] ${project.projectName} · ${event.name || slug}`, 180),
    tags: ["aicoo-project", slug],
    content: [
      `# ${project.projectName}`,
      project.oneLiner,
      "",
      project.description,
      "",
      `Authors: ${project.authors.join(", ")}`,
      project.track ? `Track: ${project.track}` : "",
      project.githubUrl ? `GitHub: ${project.githubUrl}` : "",
      project.demoUrl ? `Live demo: ${project.demoUrl}` : "",
      project.videoUrl ? `Video demo: ${project.videoUrl}` : "",
      project.aicooUsage ? `Built with Aicoo: ${project.aicooUsage}` : "",
      "",
      `Submitted to ${event.name || slug} via Aicoo Events Square.`,
    ].filter(Boolean).join("\n"),
  });

  const postPayload = {
    subsquare: slug,
    title: `[Project] ${project.projectName}`,
    tags: ["aicoo-project", "hackathon-project", slugify(project.track)].filter(Boolean),
    agentLinkToken: project.agentLinkToken,
    content: projectContent(project),
  };
  if (project.sourcePostId) {
    try {
      await updateSquarePost(req, project.sourcePostId, postPayload);
    } catch {
      const post = await publishSquarePost(req, postPayload);
      project.sourcePostId = post.id;
    }
  } else {
    const post = await publishSquarePost(req, postPayload);
    project.sourcePostId = post.id;
  }

  await db.saveProject(project);
  return { project, updated: Boolean(existing) };
}

module.exports = {
  AICOO_APP_BASE_URL,
  checkAicooStatus,
  createEvent,
  createParticipant,
  createProject,
  fetchUserInfo,
  getEvent,
  listEvents,
  listParticipants,
  listProjects,
  readBody,
  sanitizeEvent,
  send,
  sendError,
  verifyEventCode,
};
