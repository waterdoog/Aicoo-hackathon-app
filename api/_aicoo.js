const AICOO_BASE_URL = "https://www.aicoo.io/api/v1";

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
  return process.env.PULSE_API_KEY || process.env.AICOO_API_KEY || "";
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
  const token = getAuthToken(req);
  const key = token || apiKey();
  if (!key) throw new AicooError("Unauthorized: Missing Aicoo access token.", 401);

  const response = await fetch(`${AICOO_BASE_URL}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json") ? await response.json() : await response.text();
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
  const events = await grepRecords(req, MARKERS.event);
  return events.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
}

async function createEvent(req, input) {
  const slug = slugify(input.slug || input.name);
  const folderPath = `Aicoo Events/${slug}`;
  const folder = await createFolder(req, folderPath);
  const share = await createShare(req, {
    label: `${input.name} Event Square`,
    folderIds: [folder.id],
    requireSignIn: input.visibility === "private",
  });
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
    folderId: folder.id,
    folderPath,
    squareLink: share.url,
    createdAt: new Date().toISOString(),
  };
  await createNote(req, {
    title: `[Aicoo Event] ${event.name}`,
    folderId: folder.id,
    tags: ["aicoo-event", event.visibility, event.type],
    content: [recordLine(MARKERS.event, event), "", `# ${event.name}`, "", event.description].join("\n"),
  });
  return event;
}

async function listParticipants(req, slug) {
  return grepRecords(req, MARKERS.participant, slug);
}

async function createParticipant(req, slug, input) {
  const event = (await listEvents(req)).find((item) => item.slug === slug);
  if (!event) throw new AicooError("Event not found in Aicoo.", 404);
  const folder = await createFolder(req, `${event.folderPath}/People/${slugify(input.name)}`);
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
    folderId: folder.id,
    createdAt: new Date().toISOString(),
  };
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
  return participant;
}

async function listProjects(req, slug) {
  return grepRecords(req, MARKERS.project, slug);
}

async function createProject(req, slug, input) {
  const event = (await listEvents(req)).find((item) => item.slug === slug);
  if (!event) throw new AicooError("Event not found in Aicoo.", 404);
  const folder = await createFolder(req, `${event.folderPath}/Projects/${slugify(input.projectName)}`);
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
    aicooUsage: input.aicooUsage || "",
    projectAgentName: `${input.projectName} Project Agent`,
    folderId: folder.id,
    createdAt: new Date().toISOString(),
  };
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
      "",
      `Built with Aicoo: ${project.aicooUsage}`,
    ].join("\n"),
  });
  return project;
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
