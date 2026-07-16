"use strict";

/* ---------- constants & state ---------- */

const SESSION_KEY = "aicoo_session_v1";
const UNLOCK_KEY = "aicoo_event_codes_v1";
const TOKEN_REFRESH_MARGIN_MS = 90 * 1000;

const state = {
  session: null,
  currentView: "events",
  activeEvent: null,
  activeSection: "people",
  pendingPrivateEvent: null,
  eventFilter: "All",
  peopleFilter: "All",
  projectFilter: "All",
  query: "",
  selectedPersonId: null,
  selectedProjectId: null,
  events: [],
  participants: [],
  projects: [],
  loadingEvents: false,
  loadingEventData: false,
  eventsError: null,
  eventDataError: null,
};

const els = {};
[
  "sideNav", "sidebarEventName", "sidebarUserName", "sidebarUserHandle", "sidebarAvatar", "sidebarAvatarFallback",
  "authButton", "backToEvents", "heroEyebrow", "heroTitle", "heroDescription", "heroMeta",
  "eventsGrid", "peopleGrid", "participantDetail", "projectGrid", "projectDetail",
  "toast", "globalSearch", "createEventPanel", "createEventForm",
  "registerPanel", "registerForm", "registerFormTitle", "registerToggle", "submitPanel", "submitForm",
  "generatedParticipant", "generatedSubmission", "registerSuccess", "registerSuccessTitle", "registerSuccessActions",
  "submitSuccess", "submitSuccessTitle", "submitSuccessActions",
  "accessModal", "accessForm", "accessCodeInput", "accessTitle", "accessCopy",
].forEach((id) => { els[id] = document.getElementById(id); });

/* ---------- small utilities ---------- */

function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escUrl(value) {
  const text = String(value || "").trim();
  return /^https?:\/\//i.test(text) ? esc(text) : "";
}

function normalize(value) {
  return String(value || "").toLowerCase();
}

// Square posts arrive as markdown; cards read better as plain text.
function plainText(value) {
  return String(value || "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, "$1")
    .replace(/^[-*>]\s+/gm, "")
    .trim();
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function avatarUrl(person) {
  const real = String(person?.avatarUrl || person?.picture || "").trim();
  if (/^https?:\/\//i.test(real)) return real;
  return fallbackAvatar(person?.name);
}

function fallbackAvatar(seed) {
  return `https://api.dicebear.com/9.x/pixel-art/png?seed=${encodeURIComponent(seed || "Aicoo")}`;
}

function avatarImg(person, className = "avatar") {
  return `<img class="${className}" src="${esc(avatarUrl(person))}" alt="" loading="lazy"
    onerror="this.onerror=null;this.src='${esc(fallbackAvatar(person?.name))}'" />`;
}

function formatDate(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function tagList(items = [], className = "tag") {
  return (items || [])
    .filter(Boolean)
    .map((item) => `<span class="${className}">${esc(item)}</span>`)
    .join("");
}

function showToast(message, type = "info") {
  els.toast.textContent = message;
  els.toast.classList.remove("success", "error");
  if (type !== "info") els.toast.classList.add(type);
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 3200);
}

function showError(error) {
  showToast(error?.message || String(error), "error");
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Link copied", "success");
  } catch {
    window.prompt("Copy this link:", text);
  }
}

function setFormBusy(form, busy) {
  if (!form) return;
  const button = form.querySelector("button[type='submit']");
  form.querySelectorAll("input, textarea, select, button").forEach((field) => { field.disabled = busy; });
  if (button) {
    if (busy) {
      button.dataset.idleLabel = button.textContent;
      button.textContent = button.dataset.busyLabel || "Working...";
      button.classList.add("is-busy");
    } else {
      if (button.dataset.idleLabel) button.textContent = button.dataset.idleLabel;
      button.classList.remove("is-busy");
    }
  }
}

/* ---------- session management ---------- */

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (raw) {
      const session = JSON.parse(raw);
      if (session?.accessToken) return session;
    }
  } catch { /* corrupted session */ }
  // Migrate the legacy single-token storage, then retire it.
  const legacyToken = localStorage.getItem("aicoo_token");
  if (legacyToken) {
    let user = null;
    try { user = JSON.parse(localStorage.getItem("aicoo_user") || "null"); } catch { /* ignore */ }
    localStorage.removeItem("aicoo_token");
    localStorage.removeItem("aicoo_user");
    return { accessToken: legacyToken, refreshToken: null, expiresAt: 0, user };
  }
  return null;
}

function saveSession(session) {
  state.session = session;
  if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else localStorage.removeItem(SESSION_KEY);
}

function isConnected() {
  return Boolean(state.session?.accessToken);
}

function sessionFromTokenResponse(data, previous = null) {
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken || previous?.refreshToken || null,
    expiresAt: Date.now() + Math.max(60, Number(data.expiresIn) || 900) * 1000,
    user: data.user && data.user.id ? data.user : previous?.user || null,
  };
}

let refreshPromise = null;
function refreshSession() {
  if (!refreshPromise) {
    refreshPromise = (async () => {
      const refreshToken = state.session?.refreshToken;
      if (!refreshToken) throw Object.assign(new Error("Session expired. Please sign in again."), { status: 401 });
      const response = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refreshToken }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || !data.accessToken) {
        throw Object.assign(new Error("Session expired. Please sign in again."), { status: 401 });
      }
      saveSession(sessionFromTokenResponse(data, state.session));
      return state.session;
    })().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function ensureFreshToken() {
  const session = state.session;
  if (!session?.accessToken || !session.refreshToken) return;
  if (session.expiresAt && session.expiresAt - Date.now() < TOKEN_REFRESH_MARGIN_MS) {
    try {
      await refreshSession();
    } catch {
      dropSession("Your Aicoo session expired. Please sign in again.");
    }
  }
}

function dropSession(message) {
  saveSession(null);
  if (message) showToast(message, "error");
  renderShell();
}

/* ---------- API helper ---------- */

function unlockedCodes() {
  try { return JSON.parse(sessionStorage.getItem(UNLOCK_KEY) || "{}"); } catch { return {}; }
}

function rememberUnlock(slug, code) {
  const codes = unlockedCodes();
  codes[slug] = code;
  sessionStorage.setItem(UNLOCK_KEY, JSON.stringify(codes));
}

async function api(path, options = {}) {
  await ensureFreshToken();
  const attempt = async () => {
    const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
    if (state.session?.accessToken) headers.Authorization = `Bearer ${state.session.accessToken}`;
    const slug = state.activeEvent?.slug;
    if (slug && unlockedCodes()[slug]) headers["x-event-code"] = unlockedCodes()[slug];
    const response = await fetch(path, { ...options, headers });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      const error = new Error(data.error || `Request failed: ${response.status}`);
      error.status = response.status;
      error.details = data.details || null;
      throw error;
    }
    return data;
  };

  try {
    return await attempt();
  } catch (error) {
    if (error.status === 401 && state.session?.refreshToken) {
      try {
        await refreshSession();
      } catch (refreshError) {
        dropSession("Your Aicoo session expired. Please sign in again.");
        throw refreshError;
      }
      return attempt();
    }
    if (error.status === 401 && isConnected()) {
      dropSession("Your Aicoo session expired. Please sign in again.");
    }
    throw error;
  }
}

/* ---------- OAuth (PKCE) ---------- */

function generateRandomString(length = 48) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const values = new Uint32Array(length);
  window.crypto.getRandomValues(values);
  return Array.from(values, (value) => possible[value % possible.length]).join("");
}

async function generateChallenge(verifier) {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function connectAicoo() {
  try {
    const config = await api("/api/auth/config");
    if (!config.clientId) throw new Error("OAuth is not configured on the server yet.");

    const stateVal = generateRandomString(16);
    const verifier = generateRandomString(48);
    const challenge = await generateChallenge(verifier);

    sessionStorage.setItem("oauth_state", stateVal);
    sessionStorage.setItem("oauth_verifier", verifier);
    sessionStorage.setItem("oauth_return_route", window.location.hash || "");

    const params = new URLSearchParams({
      response_type: "code",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      scope: "openid profile email offline_access",
      state: stateVal,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    window.location.href = `${config.issuer || "https://www.aicoo.io"}/api/auth/oauth2/authorize?${params}`;
  } catch (error) {
    showError(error);
  }
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const oauthError = params.get("error");
  const urlState = params.get("state");
  if (!code && !oauthError) return false;

  window.history.replaceState({}, document.title, window.location.pathname);

  if (oauthError) {
    showToast(params.get("error_description") || "Sign-in was cancelled.", "error");
    return true;
  }

  try {
    const savedState = sessionStorage.getItem("oauth_state");
    const codeVerifier = sessionStorage.getItem("oauth_verifier");
    sessionStorage.removeItem("oauth_state");
    sessionStorage.removeItem("oauth_verifier");

    if (!urlState || urlState !== savedState) throw new Error("Sign-in session mismatch. Please try again.");
    if (!codeVerifier) throw new Error("Sign-in session expired. Please try again.");

    const data = await api("/api/auth/token", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier }),
    });
    saveSession(sessionFromTokenResponse(data));
    showToast(`Signed in as ${state.session.user?.name || "Aicoo user"}`, "success");
  } catch (error) {
    showError(error);
  }
  return true;
}

function signOut() {
  saveSession(null);
  state.participants = [];
  state.projects = [];
  showToast("Signed out of Aicoo");
  renderShell();
}

async function rehydrateUser() {
  if (!isConnected()) return;
  try {
    const data = await api("/api/auth/me");
    saveSession({ ...state.session, user: data.user });
  } catch {
    // api() already handled session cleanup on 401.
  }
}

/* ---------- routing ---------- */

function currentRoute() {
  const match = window.location.hash.match(/^#\/e\/([a-z0-9-]+)(?:\/(people|projects))?/i);
  if (match) return { view: "event", slug: match[1], section: match[2] || "people" };
  return { view: "events" };
}

function syncHash() {
  const hash = state.currentView === "event" && state.activeEvent
    ? `#/e/${state.activeEvent.slug}/${state.activeSection}`
    : "#/";
  if (window.location.hash !== hash) {
    window.history.replaceState({}, document.title, window.location.pathname + hash);
  }
}

/* ---------- data loading ---------- */

async function loadEvents() {
  state.loadingEvents = true;
  state.eventsError = null;
  renderShell();
  try {
    const data = await api("/api/events");
    state.events = data.events || [];
  } catch (error) {
    state.eventsError = error.message || "Could not load events.";
  } finally {
    state.loadingEvents = false;
    renderShell();
  }
}

async function loadEventData() {
  const event = state.activeEvent;
  if (!event) return;
  state.loadingEventData = true;
  state.eventDataError = null;
  renderShell();
  try {
    const [peopleData, projectData] = await Promise.all([
      api(`/api/events/${event.slug}/participants`),
      api(`/api/events/${event.slug}/projects`),
    ]);
    state.participants = peopleData.participants || [];
    state.projects = projectData.projects || [];
    if (!state.participants.some((item) => item.id === state.selectedPersonId)) {
      state.selectedPersonId = state.participants[0]?.id || null;
    }
    if (!state.projects.some((item) => item.id === state.selectedProjectId)) {
      state.selectedProjectId = state.projects[0]?.id || null;
    }
  } catch (error) {
    state.eventDataError = error.message || "Could not load this event.";
    state.participants = [];
    state.projects = [];
  } finally {
    state.loadingEventData = false;
    renderShell();
  }
}

/* ---------- filters ---------- */

function eventMatches(event) {
  const filter = state.eventFilter === "All" || event.visibility === state.eventFilter;
  const haystack = [event.name, event.type, event.visibility, event.date, event.description].join(" ");
  return filter && normalize(haystack).includes(normalize(state.query));
}

function personMatches(person) {
  const haystack = [person.name, person.role, person.company, person.intro, (person.skills || []).join(" "), (person.lookingFor || []).join(" ")].join(" ");
  const filter =
    state.peopleFilter === "All" ||
    (state.peopleFilter === "Looking for team" && person.lookingForTeam) ||
    normalize(haystack).includes(normalize(state.peopleFilter));
  return filter && normalize(haystack).includes(normalize(state.query));
}

function projectMatches(project) {
  const haystack = [project.projectName, project.oneLiner, project.description, project.track, (project.authors || []).join(" ")].join(" ");
  const filter = state.projectFilter === "All" || normalize(haystack).includes(normalize(state.projectFilter));
  return filter && normalize(haystack).includes(normalize(state.query));
}

/* ---------- rendering ---------- */

function setPanel(name) {
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === name);
  });
}

function skeletonCards(count, className) {
  return Array.from({ length: count }, () => `<div class="skeleton-card ${className}"><div></div><div></div><div></div></div>`).join("");
}

function errorState(message, retryAction) {
  return `
    <div class="empty-state error-state">
      <h3>Something went wrong</h3>
      <p>${esc(message)}</p>
      <button class="ghost-button" type="button" data-action="${retryAction}" data-allow-during-busy="true">Retry</button>
    </div>
  `;
}

function renderShell() {
  const event = state.activeEvent;
  const user = state.session?.user;
  const profileButton = document.querySelector(".profile-button");

  if (isConnected()) {
    els.authButton.textContent = "Sign out";
    els.authButton.dataset.action = "signout";
    els.authButton.classList.remove("primary-button");
    els.authButton.classList.add("ghost-button");
    if (profileButton) profileButton.dataset.action = "signout";
    els.sidebarUserName.textContent = user?.name || "Aicoo user";
    els.sidebarUserHandle.textContent = user?.email || "Connected";
    if (user?.picture) {
      els.sidebarAvatar.src = user.picture;
      els.sidebarAvatar.hidden = false;
      els.sidebarAvatarFallback.hidden = true;
    } else {
      els.sidebarAvatar.hidden = true;
      els.sidebarAvatarFallback.hidden = false;
      els.sidebarAvatarFallback.textContent = (user?.name || "A").charAt(0).toUpperCase();
    }
  } else {
    els.authButton.textContent = "Sign in with Aicoo";
    els.authButton.dataset.action = "signin";
    els.authButton.classList.add("primary-button");
    els.authButton.classList.remove("ghost-button");
    if (profileButton) profileButton.dataset.action = "signin";
    els.sidebarUserName.textContent = "Sign in required";
    els.sidebarUserHandle.textContent = "Aicoo identity";
    els.sidebarAvatar.hidden = true;
    els.sidebarAvatarFallback.hidden = false;
    els.sidebarAvatarFallback.textContent = "◍";
  }

  els.backToEvents.classList.toggle("hidden", state.currentView === "events");
  els.sidebarEventName.textContent = event ? event.name : "Browse events";

  const appShell = document.querySelector(".app-shell");

  if (state.currentView === "events") {
    if (appShell) appShell.classList.add("no-sidebar");
    els.sideNav.innerHTML = `
      <button class="nav-item active" type="button" data-action="back-events" data-allow-during-busy="true">
        <span class="icon">⌂</span><span>Events Square</span>
      </button>
    `;
    els.heroEyebrow.textContent = "Aicoo Events Square";
    els.heroTitle.textContent = "Events Square";
    els.heroDescription.textContent = "Join a hackathon, publish your agent-backed card, and talk to any participant or project through their Aicoo agent.";
    els.heroMeta.innerHTML = `
      <span>${state.events.length} event${state.events.length === 1 ? "" : "s"}</span>
      <span>Powered by Aicoo Square</span>
    `;
    els.globalSearch.placeholder = "Search events...";
    setPanel("events");
    renderEvents();
    syncHash();
    return;
  }

  if (appShell) appShell.classList.remove("no-sidebar");
  els.sideNav.innerHTML = `
    <button class="nav-item ${state.activeSection === "people" ? "active" : ""}" type="button" data-section="people" data-allow-during-busy="true">
      <span class="icon">◎</span><span>People</span>
    </button>
    <button class="nav-item ${state.activeSection === "projects" ? "active" : ""}" type="button" data-section="projects" data-allow-during-busy="true">
      <span class="icon">▣</span><span>Projects</span>
    </button>
  `;
  els.heroEyebrow.textContent = [event.type, event.visibility].filter(Boolean).join(" · ") || "Event";
  els.heroTitle.textContent = event.name;
  els.heroDescription.textContent = event.description || "";
  els.heroMeta.innerHTML = `
    ${event.date ? `<span>${esc(formatDate(event.date) || event.date)}</span>` : ""}
    <span>${state.participants.length} people</span>
    <span>${state.projects.length} projects</span>
    <button class="meta-link" type="button" data-action="copy-event-link" data-allow-during-busy="true">Copy event link</button>
    ${event.squareLink ? `<a class="meta-link" href="${escUrl(event.squareLink)}" target="_blank" rel="noreferrer">View on Aicoo Square ↗</a>` : ""}
  `;
  els.globalSearch.placeholder = state.activeSection === "people" ? "Search people, skills..." : "Search projects, tracks...";
  els.registerToggle.textContent = myParticipant() ? "Edit My Card" : "Register";
  setPanel(state.activeSection);
  renderPeople();
  renderProjects();
  syncHash();
}

function myParticipant() {
  const userId = state.session?.user?.id;
  if (!userId) return null;
  return state.participants.find((item) => item.owner?.userId === userId) || null;
}

function renderEvents() {
  if (state.loadingEvents) {
    els.eventsGrid.innerHTML = skeletonCards(6, "event-skeleton");
    return;
  }
  if (state.eventsError) {
    els.eventsGrid.innerHTML = errorState(state.eventsError, "retry-events");
    return;
  }
  const events = state.events.filter(eventMatches);
  if (!events.length) {
    els.eventsGrid.innerHTML = `
      <div class="empty-state">
        <h3>${state.query || state.eventFilter !== "All" ? "No matching events" : "No events yet"}</h3>
        <p>${state.query || state.eventFilter !== "All" ? "Try a different search or filter." : "Create the first event and it will appear here and on Aicoo Square."}</p>
      </div>
    `;
    return;
  }

  els.eventsGrid.innerHTML = events
    .map((event) => {
      const locked = event.visibility === "private" && event.isProtected && !unlockedCodes()[event.slug];
      const stats = [
        event.date ? esc(formatDate(event.date) || event.date) : "",
        event.peopleCount ? `${event.peopleCount} people` : "",
        event.postCount ? `${event.postCount} posts` : "",
      ].filter(Boolean);
      return `
        <article class="event-card ${esc(event.visibility)}" data-event-id="${esc(event.slug)}">
          <div class="card-top">
            <span class="tag">${esc(event.type || "Event")}</span>
            <span class="visibility ${locked ? "locked" : ""}">${locked ? "🔒 Private" : event.visibility === "private" ? "Unlocked" : "Public"}</span>
          </div>
          <h3>${esc(event.name)}</h3>
          <p class="event-description">${esc(event.description || "")}</p>
          <div class="hero-meta compact">${stats.map((item) => `<span>${item}</span>`).join("")}</div>
          <button class="primary-button wide" type="button" data-action="open-event" data-event-id="${esc(event.slug)}" data-allow-during-busy="true">
            ${locked ? "Unlock Event" : "Enter Event"}
          </button>
        </article>
      `;
    })
    .join("");
}

function renderPeople() {
  if (state.loadingEventData) {
    els.peopleGrid.innerHTML = skeletonCards(6, "person-skeleton");
    els.participantDetail.innerHTML = "";
    return;
  }
  if (state.eventDataError) {
    els.peopleGrid.innerHTML = errorState(state.eventDataError, "retry-event-data");
    els.participantDetail.innerHTML = "";
    return;
  }
  const people = state.participants.filter(personMatches);
  if (!people.length) {
    els.peopleGrid.innerHTML = `
      <div class="empty-state">
        <h3>${state.query || state.peopleFilter !== "All" ? "No matching people" : "No participants yet"}</h3>
        <p>${state.query || state.peopleFilter !== "All" ? "Try a different search or filter." : "Be the first to register — your card and agent link will show up here."}</p>
      </div>
    `;
  } else {
    els.peopleGrid.innerHTML = people
      .map((person) => {
        const active = person.id === state.selectedPersonId ? " active" : "";
        const mine = person.owner?.userId && person.owner.userId === state.session?.user?.id;
        return `
          <article class="person-card${active}" tabindex="0" role="button" data-person-id="${esc(person.id)}">
            <div class="card-top">
              ${avatarImg(person)}
              <span class="badge-stack">
                ${person.sharedAgentLink ? `<span class="agent-badge">⚡ Agent</span>` : ""}
                ${mine ? `<span class="mine-badge">You</span>` : ""}
              </span>
            </div>
            <h3>${esc(person.name)}</h3>
            <div class="role">${esc([person.role, person.company].filter(Boolean).join(" · "))}</div>
            <p class="card-intro">${esc(plainText(person.intro))}</p>
            <div class="tag-row">${tagList((person.skills || []).slice(0, 5))}</div>
            ${person.lookingForTeam ? `<div class="tag-row">${tagList(["Looking for team", ...(person.lookingFor || []).slice(0, 3)], "chip")}</div>` : ""}
          </article>
        `;
      })
      .join("");
  }
  renderParticipantDetail();
}

function renderParticipantDetail() {
  const person = state.participants.find((item) => item.id === state.selectedPersonId);
  if (!person) {
    els.participantDetail.innerHTML = `
      <div class="detail-empty">
        <h2>No participant selected</h2>
        <p>Select a card to see details, or register to publish the first agent-backed card.</p>
      </div>
    `;
    return;
  }
  const agentLink = escUrl(person.sharedAgentLink);
  const squareLink = escUrl(person.squarePostUrl);
  els.participantDetail.innerHTML = `
    <div class="card-top">
      ${avatarImg(person)}
      ${person.timezone ? `<span class="tag">${esc(person.timezone)}</span>` : ""}
    </div>
    <h2>${esc(person.name)}</h2>
    <div class="role">${esc([person.role, person.company].filter(Boolean).join(" · "))}</div>
    <p class="detail-intro">${esc(plainText(person.intro))}</p>
    ${(person.skills || []).length ? `<h3>Skills</h3><div class="tag-row">${tagList(person.skills)}</div>` : ""}
    ${(person.lookingFor || []).length ? `<h3>Looking for</h3><div class="tag-row">${tagList(person.lookingFor, "chip")}</div>` : ""}
    <h3>Agent</h3>
    <p>${esc(person.agentName || (agentLink ? "Aicoo agent" : "No agent shared"))}${person.allowBooking ? " · can check availability & book meetings" : ""}</p>
    <div class="detail-actions">
      ${agentLink
        ? `<a class="primary-button link-button" href="${agentLink}" target="_blank" rel="noreferrer">💬 Chat with Agent</a>
           <button class="ghost-button" type="button" data-action="copy" data-link="${agentLink}" data-allow-during-busy="true">Copy Agent Link</button>`
        : `<p class="muted-note">This participant hasn't shared an agent link yet.</p>`}
      ${squareLink ? `<a class="ghost-button link-button" href="${squareLink}" target="_blank" rel="noreferrer">View on Aicoo Square ↗</a>` : ""}
    </div>
    ${person.createdAt ? `<p class="detail-meta">Joined ${esc(formatDate(person.createdAt))}</p>` : ""}
  `;
}

function renderProjects() {
  if (state.loadingEventData) {
    els.projectGrid.innerHTML = skeletonCards(4, "project-skeleton");
    els.projectDetail.innerHTML = "";
    return;
  }
  if (state.eventDataError) {
    els.projectGrid.innerHTML = errorState(state.eventDataError, "retry-event-data");
    els.projectDetail.innerHTML = "";
    return;
  }
  const projects = state.projects.filter(projectMatches);
  if (!projects.length) {
    els.projectGrid.innerHTML = `
      <div class="empty-state">
        <h3>${state.query || state.projectFilter !== "All" ? "No matching projects" : "No submissions yet"}</h3>
        <p>${state.query || state.projectFilter !== "All" ? "Try a different search or filter." : "Submit the first project — it gets its own Aicoo agent people can talk to."}</p>
      </div>
    `;
  } else {
    els.projectGrid.innerHTML = projects
      .map((project) => {
        const active = project.id === state.selectedProjectId ? " active" : "";
        return `
          <article class="project-card${active}" tabindex="0" role="button" data-project-id="${esc(project.id)}">
            <div class="project-art"></div>
            <div class="project-body">
              <div class="card-top">
                ${project.track ? `<span class="tag">${esc(project.track)}</span>` : "<span></span>"}
                ${project.sharedProjectAgentLink ? `<span class="agent-badge">⚡ Agent</span>` : ""}
              </div>
              <h3>${esc(project.projectName)}</h3>
              <p class="card-intro">${esc(plainText(project.oneLiner))}</p>
              <div class="author-row">
                ${(project.authors || []).slice(0, 5).map((author) => `<img src="${esc(fallbackAvatar(author))}" alt="${esc(author)}" title="${esc(author)}" loading="lazy" />`).join("")}
                <span class="author-names">${esc((project.authors || []).slice(0, 3).join(", "))}${(project.authors || []).length > 3 ? " +" + ((project.authors || []).length - 3) : ""}</span>
              </div>
            </div>
          </article>
        `;
      })
      .join("");
  }
  renderProjectDetail();
}

function renderProjectDetail() {
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  if (!project) {
    els.projectDetail.innerHTML = `
      <div class="detail-empty">
        <h2>No project selected</h2>
        <p>Select a submission to see details, or submit your own project.</p>
      </div>
    `;
    return;
  }
  const link = (label, href, primary = false) => {
    const safe = escUrl(href);
    return safe
      ? `<a class="${primary ? "primary-button" : "ghost-button"} link-button" href="${safe}" target="_blank" rel="noreferrer">${label}</a>`
      : "";
  };
  const agentLink = escUrl(project.sharedProjectAgentLink);
  els.projectDetail.innerHTML = `
    <div class="card-top">
      ${project.track ? `<span class="tag">${esc(project.track)}</span>` : "<span></span>"}
      ${project.createdAt ? `<span class="detail-meta">${esc(formatDate(project.createdAt))}</span>` : ""}
    </div>
    <h2>${esc(project.projectName)}</h2>
    <p class="detail-intro">${esc(plainText(project.oneLiner))}</p>
    <h3>Description</h3>
    <p class="detail-description">${esc(plainText(project.description))}</p>
    ${(project.authors || []).length ? `<h3>Authors</h3><div class="tag-row">${tagList(project.authors)}</div>` : ""}
    ${project.aicooUsage ? `<h3>Built with Aicoo</h3><p>${esc(project.aicooUsage)}</p>` : ""}
    <div class="detail-actions">
      ${agentLink
        ? `<a class="primary-button link-button" href="${agentLink}" target="_blank" rel="noreferrer">💬 Chat with Project Agent</a>
           <button class="ghost-button" type="button" data-action="copy" data-link="${agentLink}" data-allow-during-busy="true">Copy Agent Link</button>`
        : `<p class="muted-note">No project agent link shared.</p>`}
      ${link("▶ Video Demo", project.videoUrl)}
      ${link("🔗 Live Demo", project.demoUrl)}
      ${link("⌥ GitHub Repo", project.githubUrl)}
      ${link("View on Aicoo Square ↗", project.squarePostUrl)}
    </div>
  `;
}

/* ---------- private event unlock ---------- */

function openAccessModal(event) {
  state.pendingPrivateEvent = event;
  els.accessTitle.textContent = `Unlock ${event.name}`;
  els.accessCopy.textContent = "This event is private. Enter its access code to continue.";
  els.accessCodeInput.value = "";
  els.accessModal.classList.remove("hidden");
  els.accessCodeInput.focus();
}

function closeAccessModal() {
  state.pendingPrivateEvent = null;
  els.accessModal.classList.add("hidden");
}

async function enterEvent(event, section = "people") {
  state.currentView = "event";
  state.activeEvent = event;
  state.activeSection = section;
  state.query = "";
  els.globalSearch.value = "";
  els.registerPanel.classList.add("hidden");
  els.submitPanel.classList.add("hidden");
  els.registerSuccess.classList.add("hidden");
  els.submitSuccess.classList.add("hidden");
  closeAccessModal();
  window.scrollTo({ top: 0, behavior: "instant" });
  renderShell();
  await loadEventData();
}

function attemptOpenEvent(slug, section = "people") {
  const event = state.events.find((item) => item.slug === slug);
  if (!event) return;
  const locked = event.visibility === "private" && event.isProtected && !unlockedCodes()[event.slug];
  if (locked) {
    openAccessModal(event);
    return;
  }
  enterEvent(event, section);
}

function applyInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const invite = params.get("invite");
  const eventSlug = params.get("event");
  if (invite && eventSlug) {
    rememberUnlock(eventSlug, invite);
    showToast("Invite code applied");
  }
}

/* ---------- forms ---------- */

function prefillRegisterForm() {
  const form = els.registerForm;
  const mine = myParticipant();
  const user = state.session?.user;
  const setField = (name, value) => {
    if (form.elements[name] && value !== undefined && value !== null) form.elements[name].value = value;
  };
  if (mine) {
    els.registerFormTitle.textContent = "Update your participant card";
    setField("name", mine.name);
    setField("role", mine.role);
    setField("company", mine.company);
    setField("timezone", mine.timezone);
    setField("intro", mine.intro);
    setField("skills", (mine.skills || []).join(", "));
    setField("lookingFor", (mine.lookingFor || []).join(", "));
    setField("agentName", mine.agentName);
    form.elements.lookingForTeam.checked = Boolean(mine.lookingForTeam);
    form.elements.allowBooking.checked = Boolean(mine.allowBooking);
    return;
  }
  els.registerFormTitle.textContent = "Create your participant card";
  if (!form.elements.name.value) setField("name", user?.name || "");
  if (!form.elements.timezone.value) {
    try { setField("timezone", Intl.DateTimeFormat().resolvedOptions().timeZone || ""); } catch { /* ignore */ }
  }
}

function requireSignIn(actionLabel) {
  if (isConnected()) return true;
  showToast(`Sign in with Aicoo to ${actionLabel}`);
  connectAicoo();
  return false;
}

function successActions(link, squareLink) {
  const safe = escUrl(link);
  const safeSquare = escUrl(squareLink);
  return [
    safe ? `<a class="primary-button link-button" href="${safe}" target="_blank" rel="noreferrer">💬 Open Agent Chat</a>` : "",
    safe ? `<button class="ghost-button" type="button" data-action="copy" data-link="${safe}" data-allow-during-busy="true">Copy Agent Link</button>` : "",
    safeSquare ? `<a class="ghost-button link-button" href="${safeSquare}" target="_blank" rel="noreferrer">View on Aicoo Square ↗</a>` : "",
  ].filter(Boolean).join("");
}

async function submitRegisterForm() {
  const form = els.registerForm;
  if (!form.reportValidity()) return;
  setFormBusy(form, true);
  try {
    const body = Object.fromEntries(new FormData(form));
    body.skills = csv(body.skills);
    body.lookingFor = csv(body.lookingFor);
    body.lookingForTeam = body.lookingForTeam === "on";
    body.allowBooking = body.allowBooking === "on";
    const data = await api(`/api/events/${state.activeEvent.slug}/participants`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const participant = data.participant;
    state.participants = [participant, ...state.participants.filter((item) => item.id !== participant.id)];
    state.selectedPersonId = participant.id;
    els.registerSuccessTitle.textContent = data.updated ? "Your card was updated" : "Your agent card is live";
    els.generatedParticipant.innerHTML = `
      ${avatarImg(participant)}
      <h3>${esc(participant.name)}</h3>
      <p>${esc([participant.role, participant.company].filter(Boolean).join(" · "))}</p>
      <div class="tag-row centered">${tagList((participant.skills || []).slice(0, 5))}</div>
    `;
    els.registerSuccessActions.innerHTML = successActions(participant.sharedAgentLink, participant.squarePostUrl || (participant.sourcePostId ? `https://www.aicoo.io/square/p/${participant.sourcePostId}` : ""));
    els.registerSuccess.classList.remove("hidden");
    showToast(data.updated ? "Participant card updated" : "Participant card and agent link created", "success");
    renderShell();
  } catch (error) {
    showError(error);
  } finally {
    setFormBusy(form, false);
  }
}

async function submitProjectForm() {
  const form = els.submitForm;
  if (!form.reportValidity()) return;
  setFormBusy(form, true);
  try {
    const body = Object.fromEntries(new FormData(form));
    body.authors = csv(body.authors);
    const data = await api(`/api/events/${state.activeEvent.slug}/projects`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    const project = data.project;
    state.projects = [project, ...state.projects.filter((item) => item.id !== project.id)];
    state.selectedProjectId = project.id;
    els.submitSuccessTitle.textContent = data.updated ? "Submission updated" : "Project published";
    els.generatedSubmission.innerHTML = `
      <h3>${esc(project.projectName)}</h3>
      <p>${esc(project.oneLiner || "")}</p>
      ${project.track ? `<span class="tag">${esc(project.track)}</span>` : ""}
    `;
    els.submitSuccessActions.innerHTML = successActions(project.sharedProjectAgentLink, project.squarePostUrl || (project.sourcePostId ? `https://www.aicoo.io/square/p/${project.sourcePostId}` : ""));
    els.submitSuccess.classList.remove("hidden");
    showToast(data.updated ? "Project submission updated" : "Project and project agent created", "success");
    renderShell();
  } catch (error) {
    showError(error);
  } finally {
    setFormBusy(form, false);
  }
}

async function submitCreateEventForm() {
  const form = els.createEventForm;
  if (!form.reportValidity()) return;
  setFormBusy(form, true);
  try {
    const body = Object.fromEntries(new FormData(form));
    const data = await api("/api/events", { method: "POST", body: JSON.stringify(body) });
    if (body.visibility === "private" && body.accessCode) {
      rememberUnlock(data.event.slug, body.accessCode);
    }
    els.createEventPanel.classList.add("hidden");
    form.reset();
    showToast("Event created and announced on Aicoo Square", "success");
    await loadEvents();
  } catch (error) {
    showError(error);
  } finally {
    setFormBusy(form, false);
  }
}

/* ---------- event bindings ---------- */

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (action) {
      const type = action.dataset.action;
      if (type === "signin") await connectAicoo();
      if (type === "signout") signOut();
      if (type === "back-events") {
        state.currentView = "events";
        state.activeEvent = null;
        state.query = "";
        els.globalSearch.value = "";
        window.scrollTo({ top: 0, behavior: "instant" });
        renderShell();
        if (!state.events.length && !state.loadingEvents) loadEvents();
      }
      if (type === "toggle-create-event") {
        if (!requireSignIn("create an event")) return;
        els.createEventPanel.classList.toggle("hidden");
      }
      if (type === "open-event") attemptOpenEvent(action.dataset.eventId);
      if (type === "close-access") closeAccessModal();
      if (type === "toggle-register") {
        if (!requireSignIn("register for this event")) return;
        prefillRegisterForm();
        els.registerSuccess.classList.add("hidden");
        els.registerPanel.classList.toggle("hidden");
        if (!els.registerPanel.classList.contains("hidden")) {
          els.registerPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      if (type === "toggle-submit") {
        if (!requireSignIn("submit a project")) return;
        els.submitSuccess.classList.add("hidden");
        els.submitPanel.classList.toggle("hidden");
        if (!els.submitPanel.classList.contains("hidden")) {
          els.submitPanel.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }
      if (type === "copy") await copyText(action.dataset.link);
      if (type === "copy-event-link") {
        const url = `${window.location.origin}${window.location.pathname}#/e/${state.activeEvent?.slug || ""}/people`;
        await copyText(url);
      }
      if (type === "retry-events") loadEvents();
      if (type === "retry-event-data") loadEventData();
    }

    const sectionButton = event.target.closest("[data-section]");
    if (sectionButton) {
      state.activeSection = sectionButton.dataset.section;
      renderShell();
    }

    const personCard = event.target.closest("[data-person-id]");
    if (personCard && !event.target.closest("[data-action]") && !event.target.closest("a")) {
      state.selectedPersonId = personCard.dataset.personId;
      renderPeople();
    }

    const projectCard = event.target.closest("[data-project-id]");
    if (projectCard && !event.target.closest("[data-action]") && !event.target.closest("a")) {
      state.selectedProjectId = projectCard.dataset.projectId;
      renderProjects();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !els.accessModal.classList.contains("hidden")) closeAccessModal();
    if (event.key === "Enter") {
      const card = event.target.closest?.("[data-person-id], [data-project-id]");
      if (card) card.click();
    }
  });

  document.querySelectorAll("[data-filter-group]").forEach((group) => {
    const groupName = group.dataset.filterGroup;
    group.querySelectorAll("button").forEach((button) => {
      button.addEventListener("click", () => {
        group.querySelectorAll("button").forEach((item) => item.classList.remove("active"));
        button.classList.add("active");
        if (groupName === "events") { state.eventFilter = button.dataset.filter; renderEvents(); }
        if (groupName === "people") { state.peopleFilter = button.dataset.filter; renderPeople(); }
        if (groupName === "projects") { state.projectFilter = button.dataset.filter; renderProjects(); }
      });
    });
  });

  els.globalSearch.addEventListener("input", (event) => {
    state.query = event.target.value;
    if (state.currentView === "events") renderEvents();
    else { renderPeople(); renderProjects(); }
  });

  els.accessForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const target = state.pendingPrivateEvent;
    if (!target) return;
    setFormBusy(els.accessForm, true);
    try {
      const code = els.accessCodeInput.value.trim();
      const data = await api(`/api/events/${target.slug}/unlock`, {
        method: "POST",
        body: JSON.stringify({ accessCode: code }),
      });
      rememberUnlock(target.slug, data.eventCode || code);
      showToast("Event unlocked", "success");
      enterEvent(target);
    } catch (error) {
      showError(error);
    } finally {
      setFormBusy(els.accessForm, false);
    }
  });

  els.createEventForm.addEventListener("submit", (event) => { event.preventDefault(); submitCreateEventForm(); });
  els.registerForm.addEventListener("submit", (event) => { event.preventDefault(); submitRegisterForm(); });
  els.submitForm.addEventListener("submit", (event) => { event.preventDefault(); submitProjectForm(); });

  window.addEventListener("hashchange", () => {
    const route = currentRoute();
    if (route.view === "events" && state.currentView !== "events") {
      state.currentView = "events";
      state.activeEvent = null;
      renderShell();
    } else if (route.view === "event" && route.slug !== state.activeEvent?.slug) {
      attemptOpenEvent(route.slug, route.section);
    } else if (route.view === "event" && route.section !== state.activeSection) {
      state.activeSection = route.section;
      renderShell();
    }
  });
}

/* ---------- boot ---------- */

async function initApp() {
  applyInviteFromUrl();
  bindEvents();
  state.session = loadSession();
  const route = currentRoute(); // capture before the first render rewrites the hash
  renderShell();

  const handled = await handleOAuthCallback();
  if (!handled) rehydrateUser();

  await loadEvents();

  const returnHash = (sessionStorage.getItem("oauth_return_route") || "").match(/^#\/e\/([a-z0-9-]+)(?:\/(people|projects))?/i);
  sessionStorage.removeItem("oauth_return_route");
  if (returnHash) {
    attemptOpenEvent(returnHash[1], returnHash[2] || "people");
  } else if (route.view === "event") {
    attemptOpenEvent(route.slug, route.section);
  }
}

initApp();
