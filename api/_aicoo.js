const AICOO_OS_BASE_URL = "https://www.aicoo.io/api/v1";
const AICOO_APP_BASE_URL = "https://www.aicoo.io";
const db = require("../lib/db");

const MARKERS = {
  event: "AICOO_EVENT_RECORD",
  participant: "AICOO_PARTICIPANT_RECORD",
  project: "AICOO_PROJECT_RECORD",
};

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
    return authHeader.substring(7);
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

function extractRecords(payload, marker) {
  const text = JSON.stringify(payload);
  const pattern = new RegExp(`${marker}\\\\s+([A-Za-z0-9_-]+)`, "g");
  const records = [];
  for (const match of text.matchAll(pattern)) {
    try {
      records.push(decodeRecord(match[1]));
    } catch {
      // Ignore malformed old records.
    }
  }
  return records;
}

async function aicooFetch(req, path, options = {}) {
  return authedFetch(req, `${AICOO_OS_BASE_URL}${path}`, options);
}

async function squareFetch(req, path, options = {}) {
  return authedFetch(req, `${AICOO_APP_BASE_URL}/api/square${path}`, options);
}

async function authedFetch(req, url, options = {}) {
  const token = getAuthToken(req);
  const key = token || apiKey();
  if (!key) throw new AicooError("Unauthorized: Missing Aicoo access token.", 401);

  const doFetch = async (authKey) => {
    const response = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${authKey}`,
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
    const contentType = response.headers.get("content-type") || "";
    const data = contentType.includes("application/json") ? await response.json() : await response.text();
    return { response, data };
  };

  let { response, data } = await doFetch(key);
  if (!response.ok && token && apiKey() && response.status === 401) {
    ({ response, data } = await doFetch(apiKey()));
  }

  if (!response.ok) {
    const message = typeof data === "object" && data?.message ? data.message : `Aicoo API request failed: ${response.status}`;
    throw new AicooError(message, response.status, data);
  }
  return data;
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
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function firstId(...values) {
  return values.find((value) => value === 0 || value) ?? null;
}

function shareUrl(data) {
  return data?.url || data?.shareUrl || data?.link || data?.shareLink || data?.publicUrl || data?.data?.url || "";
}

function firstLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function truncate(value, length) {
  const text = String(value || "").trim();
  return text.length > length ? `${text.slice(0, length - 3)}...` : text;
}

function tokenFromShareUrl(url) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get("token") || parsed.pathname.split("/").filter(Boolean).pop() || null;
  } catch {
    return null;
  }
}

function mapSubsquareToEvent(item) {
  const slug = item.subsquare || slugify(item.name);
  const name = item.name || `s/${slug}`;
  return {
    id: slug,
    slug,
    name,
    type: slug.includes("hack") || slug.includes("event") ? "Hackathon" : "Subsquare",
    visibility: item.isPrivate ? "private" : "public",
    accessCode: "",
    inviteToken: slug,
    date: item.latestPostAt ? new Date(item.latestPostAt).toISOString().slice(0, 10) : "",
    description: item.description || "Community-created subsquare.",
    postCount: item.postCount || 0,
    peopleCount: item.peopleCount || 0,
    latestPostAt: item.latestPostAt || "",
    role: item.role || null,
    canDelete: Boolean(item.canDelete),
    squareLink: `${AICOO_APP_BASE_URL}/square?subsquare=${encodeURIComponent(slug)}`,
  };
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

function mapPostToParticipant(post, slug) {
  const record = extractFirstRecordFromText(post.content, MARKERS.participant);
  if (record) {
    return { ...record, sourcePostId: post.id, createdAt: record.createdAt || post.createdAt };
  }
  return {
    id: String(post.id),
    eventSlug: slug,
    name: post.ownerName || [post.firstName, post.lastName].filter(Boolean).join(" ") || post.username || "Participant",
    role: post.headline || "Participant",
    company: "",
    timezone: "",
    intro: post.content || "",
    skills: post.tags || [],
    lookingForTeam: false,
    lookingFor: [],
    agentName: post.agentName || `${post.ownerName || post.username || "Participant"}'s Aicoo Agent`,
    sharedAgentLink: linkFromText(post.content),
    sourcePostId: post.id,
    createdAt: post.createdAt,
  };
}

function mapPostToProject(post, slug) {
  const record = extractFirstRecordFromText(post.content, MARKERS.project);
  if (record) {
    return { ...record, sourcePostId: post.id, createdAt: record.createdAt || post.createdAt };
  }
  const author = post.ownerName || [post.firstName, post.lastName].filter(Boolean).join(" ") || post.username || "Aicoo member";
  return {
    id: String(post.id),
    eventSlug: slug,
    projectName: post.title,
    oneLiner: truncate(firstLine(post.content), 140),
    description: post.content || "",
    track: post.subsquare ? `s/${post.subsquare}` : "Aicoo Square",
    authors: [author],
    githubUrl: labeledUrl(post.content, ["github", "repo", "github repo"]),
    demoUrl: labeledUrl(post.content, ["live demo", "demo"]),
    videoUrl: labeledUrl(post.content, ["video demo", "video"]),
    aicooUsage: "",
    projectAgentName: post.agentName || `${post.title} Project Agent`,
    sharedProjectAgentLink: labeledUrl(post.content, ["chat with project agent", "project agent"]),
    sourcePostId: post.id,
    createdAt: post.createdAt,
    likeCount: post.likeCount || 0,
    commentCount: post.commentCount || 0,
    liked: Boolean(post.liked),
  };
}

function mergeById(primary, secondary) {
  const seen = new Set();
  return [...primary, ...secondary].filter((item) => {
    const key = String(item.id || item.slug || item.sourcePostId || "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function aicooUnavailable(error) {
  return {
    status: error.status || 500,
    message: error.message || "Aicoo sync failed",
  };
}

async function listSquarePosts(req, slug) {
  const data = await squareFetch(req, `?subsquare=${encodeURIComponent(slug)}&limit=100`);
  return data.posts || [];
}

async function publishSquarePost(req, { subsquare, title, content, tags = [], agentLink = "" }) {
  const body = {
    subsquare,
    title,
    content,
    tags,
    agentLinkToken: tokenFromShareUrl(agentLink),
    reachability: agentLink ? "open" : "closed",
  };
  const data = await squareFetch(req, "", {
    method: "POST",
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
    method: "POST",
    body: JSON.stringify({ path }),
  });
  const folder = data.folder || data.data?.folder || data;
  return { id: firstId(folder?.id, data.folderId, data.id), raw: data };
}

async function createNote(req, { title, content, folderId, tags = [] }) {
  return aicooFetch(req, "/os/notes", {
    method: "POST",
    body: JSON.stringify({ title, content, folderId, tags }),
  });
}

async function createShare(req, { label, folderIds, requireSignIn = false }) {
  if (!folderIds?.length || folderIds.some((id) => id == null)) return { url: "", raw: null };
  const data = await aicooFetch(req, "/os/share", {
    method: "POST",
    body: JSON.stringify({
      scope: "folders",
      access: "read",
      notesAccess: "read",
      folderIds,
      label,
      expiresIn: "30d",
      requireSignIn,
      identity: { loadCoo: true, loadUser: true, loadPolicy: true },
    }),
  });
  return { url: shareUrl(data), raw: data };
}

async function grepRecords(req, marker, folderName) {
  const body = { pattern: marker, mode: "literal", contextBefore: 0, contextAfter: 0 };
  if (folderName) body.folderName = folderName;
  const data = await aicooFetch(req, "/os/notes/grep", { method: "POST", body: JSON.stringify(body) });
  return extractRecords(data, marker);
}

async function listEvents(req) {
  const dbEvents = await db.listEvents();
  try {
    const data = await squareFetch(req, "/subsquares");
    const squareEvents = (data.subsquares || []).map(mapSubsquareToEvent);
    return mergeById(dbEvents, squareEvents);
  } catch (error) {
    if (db.hasDatabase()) return dbEvents;
    throw error;
  }
}

async function createEvent(req, input) {
  const slug = slugify(input.slug || input.name);
  const folderPath = `Aicoo Square/events/${slug}`;
  const event = {
    id: slug,
    slug,
    name: input.name,
    type: input.type || "Hackathon",
    visibility: input.visibility || "public",
    accessCode: input.accessCode || "",
    inviteToken: input.inviteToken || `${slug}-invite`,
    date: input.date || "",
    description: input.description || "",
    folderId: null,
    folderPath,
    squareLink: `${AICOO_APP_BASE_URL}/square?subsquare=${encodeURIComponent(slug)}`,
    createdAt: new Date().toISOString(),
  };
  try {
    const folder = await createFolder(req, folderPath);
    const share = await createShare(req, {
      label: `${input.name} Event Context`,
      folderIds: [folder.id],
      requireSignIn: input.visibility === "private",
    });
    event.folderId = folder.id;
    event.squareLink = share.url || event.squareLink;
    await createNote(req, {
      title: `[Aicoo Event] ${event.name}`,
      folderId: folder.id,
      tags: ["aicoo-event", event.visibility, event.type],
      content: [recordLine(MARKERS.event, event), "", `# ${event.name}`, "", event.description].join("\n"),
    });
    const post = await publishSquarePost(req, {
      subsquare: "events",
      title: `[Event] ${event.name}`,
      tags: ["aicoo-event", event.type, event.visibility],
      agentLink: share.url,
      content: [
        recordLine(MARKERS.event, event),
        "",
        event.description,
        "",
        event.squareLink ? `Context agent: ${event.squareLink}` : "",
        "",
        "This is an event announcement. Create or manage the matching subsquare in Aicoo Square for the live event feed.",
      ].join("\n"),
    });
    event.sourcePostId = post.id;
  } catch (error) {
    if (!db.hasDatabase()) throw error;
    event.aicooSync = aicooUnavailable(error);
  }
  return db.saveEvent(event);
}

async function listParticipants(req, slug) {
  const dbParticipants = await db.listParticipants(slug);
  try {
    const posts = await listSquarePosts(req, slug);
    const squareParticipants = posts
      .filter((post) => hasParticipantSignal(post) && !hasProjectSignal(post))
      .map((post) => mapPostToParticipant(post, slug));
    return mergeById(dbParticipants, squareParticipants);
  } catch (error) {
    if (db.hasDatabase()) return dbParticipants;
    throw error;
  }
}

async function createParticipant(req, slug, input) {
  const event = (await listEvents(req)).find((item) => item.slug === slug) || (db.hasDatabase() ? { slug, name: slug } : null);
  if (!event) throw new AicooError("Subsquare not found in Aicoo Square.", 404);
  const participant = {
    id: `${slug}-${slugify(input.name)}-${Date.now()}`,
    eventSlug: slug,
    name: input.name,
    role: input.role,
    company: input.company,
    timezone: input.timezone,
    intro: input.intro,
    skills: input.skills || [],
    lookingForTeam: Boolean(input.lookingForTeam),
    lookingFor: input.lookingFor || [],
    agentName: input.agentName || `${input.name}'s Aicoo Agent`,
    folderId: null,
    createdAt: new Date().toISOString(),
  };
  try {
    const folder = await createFolder(req, `Aicoo Square/${slug}/People/${slugify(input.name)}`);
    participant.folderId = folder.id;
    const share = await createShare(req, { label: `${participant.name} · ${event.name}`, folderIds: [folder.id] });
    participant.sharedAgentLink = share.url;
    await createNote(req, {
      title: `[Participant] ${participant.name} · ${event.name}`,
      folderId: folder.id,
      tags: ["aicoo-participant", slug],
      content: [
        recordLine(MARKERS.participant, participant),
        "",
        `# ${participant.name}`,
        `Role: ${participant.role}`,
        `Company: ${participant.company}`,
        "",
        participant.intro,
        "",
        `Skills: ${participant.skills.join(", ")}`,
        `Looking for: ${participant.lookingFor.join(", ")}`,
      ].join("\n"),
    });
    const post = await publishSquarePost(req, {
      subsquare: slug,
      title: `[Participant] ${participant.name}${participant.role ? ` · ${participant.role}` : ""}`,
      tags: ["aicoo-participant", "hackathon-participant", ...participant.skills.slice(0, 5)],
      agentLink: participant.sharedAgentLink,
      content: [
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
      ].filter(Boolean).join("\n"),
    });
    participant.sourcePostId = post.id;
  } catch (error) {
    if (!db.hasDatabase()) throw error;
    participant.aicooSync = aicooUnavailable(error);
  }
  return db.saveParticipant(participant);
}

async function listProjects(req, slug) {
  const dbProjects = await db.listProjects(slug);
  try {
    const posts = await listSquarePosts(req, slug);
    const squareProjects = posts
      .filter((post) => hasProjectSignal(post))
      .map((post) => mapPostToProject(post, slug));
    return mergeById(dbProjects, squareProjects);
  } catch (error) {
    if (db.hasDatabase()) return dbProjects;
    throw error;
  }
}

async function createProject(req, slug, input) {
  const event = (await listEvents(req)).find((item) => item.slug === slug) || (db.hasDatabase() ? { slug, name: slug } : null);
  if (!event) throw new AicooError("Subsquare not found in Aicoo Square.", 404);
  const project = {
    id: `${slug}-${slugify(input.projectName)}-${Date.now()}`,
    eventSlug: slug,
    projectName: input.projectName,
    oneLiner: input.oneLiner,
    description: input.description,
    track: input.track || "AI Agents",
    authors: input.authors || [],
    githubUrl: input.githubUrl || "",
    demoUrl: input.demoUrl || "",
    videoUrl: input.videoUrl || "",
    aicooUsage: input.aicooUsage || "",
    projectAgentName: `${input.projectName} Project Agent`,
    folderId: null,
    createdAt: new Date().toISOString(),
  };
  try {
    const folder = await createFolder(req, `Aicoo Square/${slug}/Projects/${slugify(input.projectName)}`);
    project.folderId = folder.id;
    const share = await createShare(req, { label: `${project.projectName} Project Agent · ${event.name}`, folderIds: [folder.id] });
    project.sharedProjectAgentLink = share.url;
    await createNote(req, {
      title: `[Project] ${project.projectName} · ${event.name}`,
      folderId: folder.id,
      tags: ["aicoo-project", slug, project.track],
      content: [
        recordLine(MARKERS.project, project),
        "",
        `# ${project.projectName}`,
        project.oneLiner,
        "",
        project.description,
        "",
        `Authors: ${project.authors.join(", ")}`,
        `Track: ${project.track}`,
        `GitHub: ${project.githubUrl}`,
        `Demo: ${project.demoUrl}`,
        `Video demo: ${project.videoUrl}`,
        "",
        `Built with Aicoo: ${project.aicooUsage}`,
      ].join("\n"),
    });
    const post = await publishSquarePost(req, {
      subsquare: slug,
      title: `[Project] ${project.projectName}`,
      tags: ["aicoo-project", "hackathon-project", project.track].filter(Boolean),
      agentLink: project.sharedProjectAgentLink,
      content: [
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
      ].filter(Boolean).join("\n"),
    });
    project.sourcePostId = post.id;
  } catch (error) {
    if (!db.hasDatabase()) throw error;
    project.aicooSync = aicooUnavailable(error);
  }
  return db.saveProject(project);
}

module.exports = {
  checkAicooStatus,
  createEvent,
  createParticipant,
  createProject,
  listEvents,
  listParticipants,
  listProjects,
  readBody,
  send,
  sendError,
};
