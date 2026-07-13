const avatar = (seed) => `https://api.dicebear.com/9.x/pixel-art/png?seed=${encodeURIComponent(seed || "Aicoo")}`;

const state = {
  connected: false,
  currentView: "events",
  activeEvent: null,
  activeSection: "people",
  pendingPrivateEvent: null,
  unlocked: new Set(),
  eventFilter: "All",
  peopleFilter: "All",
  projectFilter: "All",
  query: "",
  selectedPersonId: null,
  selectedProjectId: null,
  events: [],
  participants: [],
  projects: [],
  busy: false,
};

const els = {
  sideNav: document.querySelector("#sideNav"),
  sidebarEventName: document.querySelector("#sidebarEventName"),
  sidebarUserName: document.querySelector("#sidebarUserName"),
  sidebarUserHandle: document.querySelector("#sidebarUserHandle"),
  authButton: document.querySelector("#authButton"),
  backToEvents: document.querySelector("#backToEvents"),
  heroEyebrow: document.querySelector("#heroEyebrow"),
  heroTitle: document.querySelector("#heroTitle"),
  heroDescription: document.querySelector("#heroDescription"),
  heroMeta: document.querySelector("#heroMeta"),
  eventsGrid: document.querySelector("#eventsGrid"),
  peopleGrid: document.querySelector("#peopleGrid"),
  participantDetail: document.querySelector("#participantDetail"),
  projectGrid: document.querySelector("#projectGrid"),
  projectDetail: document.querySelector("#projectDetail"),
  phonePeople: document.querySelector("#phonePeople"),
  phoneTitle: document.querySelector("#phoneTitle"),
  toast: document.querySelector("#toast"),
  search: document.querySelector("#globalSearch"),
  createEventPanel: document.querySelector("#createEventPanel"),
  createEventForm: document.querySelector("#createEventForm"),
  registerPanel: document.querySelector("#registerPanel"),
  submitPanel: document.querySelector("#submitPanel"),
  registerForm: document.querySelector("#registerForm"),
  submitForm: document.querySelector("#submitForm"),
  generatedParticipant: document.querySelector("#generatedParticipant"),
  generatedSubmission: document.querySelector("#generatedSubmission"),
  registerSuccess: document.querySelector("#registerSuccess"),
  submitSuccess: document.querySelector("#submitSuccess"),
  accessModal: document.querySelector("#accessModal"),
  accessForm: document.querySelector("#accessForm"),
  accessCodeInput: document.querySelector("#accessCodeInput"),
  accessTitle: document.querySelector("#accessTitle"),
  accessCopy: document.querySelector("#accessCopy"),
};

function normalize(value) {
  return String(value || "").toLowerCase();
}

function csv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function setBusy(value) {
  state.busy = value;
  document.querySelectorAll("button").forEach((button) => {
    if (!button.dataset.allowDuringBusy) button.disabled = value;
  });
}

function showToast(message) {
  els.toast.textContent = message;
  els.toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => els.toast.classList.remove("show"), 2600);
}

function showError(error) {
  showToast(error.message || String(error));
}

// PKCE Helpers
function generateRandomString(length = 48) {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let text = '';
  for (let i = 0; i < length; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

async function sha256(plain) {
  const encoder = new TextEncoder();
  const data = encoder.encode(plain);
  return window.crypto.subtle.digest('SHA-256', data);
}

function base64urlencode(a) {
  let str = "";
  const bytes = new Uint8Array(a);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    str += String.fromCharCode(bytes[i]);
  }
  return btoa(str)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function generateChallenge(verifier) {
  const hashed = await sha256(verifier);
  return base64urlencode(hashed);
}

async function api(path, options = {}) {
  const token = localStorage.getItem("aicoo_token");
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  const response = await fetch(path, {
    ...options,
    headers,
  });
  const data = await response.json();
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

async function connectAicoo() {
  setBusy(true);
  try {
    const config = await api("/api/auth/config");
    if (!config.clientId) {
      throw new Error("OAuth Client ID not configured on the server.");
    }

    const stateVal = generateRandomString(16);
    const verifier = generateRandomString(48);
    const challenge = await generateChallenge(verifier);

    sessionStorage.setItem("oauth_state", stateVal);
    sessionStorage.setItem("oauth_verifier", verifier);

    const authUrl = `${config.issuer || "https://www.aicoo.io"}/api/auth/oauth2/authorize?` +
      `response_type=code&` +
      `client_id=${encodeURIComponent(config.clientId)}&` +
      `redirect_uri=${encodeURIComponent(config.redirectUri)}&` +
      `scope=${encodeURIComponent("openid profile email offline_access")}&` +
      `state=${encodeURIComponent(stateVal)}&` +
      `code_challenge=${encodeURIComponent(challenge)}&` +
      `code_challenge_method=S256`;

    window.location.href = authUrl;
  } catch (error) {
    showError(error);
    setBusy(false);
  }
}

async function handleOAuthCallback() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const urlState = params.get("state");
  if (!code) return;

  setBusy(true);
  try {
    const savedState = sessionStorage.getItem("oauth_state");
    const codeVerifier = sessionStorage.getItem("oauth_verifier");

    sessionStorage.removeItem("oauth_state");
    sessionStorage.removeItem("oauth_verifier");

    if (!urlState || urlState !== savedState) {
      throw new Error("Invalid state parameter (CSRF protection failed)");
    }
    if (!codeVerifier) {
      throw new Error("Missing code verifier in session cache");
    }

    const data = await api("/api/auth/token", {
      method: "POST",
      body: JSON.stringify({ code, codeVerifier })
    });

    if (data.ok && data.accessToken) {
      localStorage.setItem("aicoo_token", data.accessToken);
      localStorage.setItem("aicoo_user", JSON.stringify(data.user || {}));
      
      state.connected = true;
      state.user = data.user;

      showToast(`Connected as ${data.user.name || "Aicoo User"}`);
    } else {
      throw new Error(data.error || "Token exchange failed");
    }
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    window.history.replaceState({}, document.title, window.location.pathname);
    renderShell();
    await loadEvents();
  }
}

function signoutAicoo() {
  localStorage.removeItem("aicoo_token");
  localStorage.removeItem("aicoo_user");
  state.connected = false;
  state.user = null;
  state.events = [];
  state.participants = [];
  state.projects = [];
  state.activeEvent = null;
  state.currentView = "events";
  showToast("Disconnected from Aicoo");
  renderShell();
}

async function loadEvents() {
  setBusy(true);
  try {
    const data = await api("/api/events");
    state.events = data.events || [];
  } catch (error) {
    if (error.message.includes("Unauthorized") || error.message.includes("401")) {
      localStorage.removeItem("aicoo_token");
      localStorage.removeItem("aicoo_user");
      state.connected = false;
      state.user = null;
    }
    showError(error);
  } finally {
    setBusy(false);
    renderShell();
  }
}

async function loadEventData(event) {
  setBusy(true);
  try {
    const [peopleData, projectData] = await Promise.all([
      api(`/api/events/${event.slug}/participants`),
      api(`/api/events/${event.slug}/projects`),
    ]);
    state.participants = peopleData.participants || [];
    state.projects = projectData.projects || [];
    state.selectedPersonId = state.participants[0]?.id || null;
    state.selectedProjectId = state.projects[0]?.id || null;
  } catch (error) {
    showError(error);
  } finally {
    setBusy(false);
    renderShell();
  }
}

function tagList(items = [], className = "tag") {
  return items.map((item) => `<span class="${className}">${item}</span>`).join("");
}

function eventMatches(event) {
  const filter = state.eventFilter === "All" || event.visibility === state.eventFilter;
  const haystack = [event.name, event.type, event.visibility, event.date, event.description].join(" ");
  return filter && normalize(haystack).includes(normalize(state.query));
}

function personMatches(person) {
  const haystack = [person.name, person.role, person.company, person.intro, (person.skills || []).join(" "), (person.lookingFor || []).join(" ")].join(" ");
  return normalize(haystack).includes(normalize(state.query));
}

function projectMatches(project) {
  const haystack = [project.projectName, project.oneLiner, project.description, project.track, (project.authors || []).join(" ")].join(" ");
  return normalize(haystack).includes(normalize(state.query));
}

function setPanel(name) {
  document.querySelectorAll("[data-view-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.viewPanel === name);
  });
}

function renderShell() {
  const event = state.activeEvent;
  const profileButton = document.querySelector(".profile-button");
  if (state.connected && state.user) {
    els.authButton.textContent = "Disconnect Aicoo";
    els.authButton.dataset.action = "signout";
    if (profileButton) profileButton.dataset.action = "signout";
    els.sidebarUserName.textContent = state.user.name || "Connected User";
    els.sidebarUserHandle.textContent = state.user.email || "Connected";
    const profileImg = document.querySelector(".profile-button img");
    if (profileImg) {
      profileImg.src = state.user.picture || avatar(state.user.name || "Aicoo");
    }
  } else {
    els.authButton.textContent = "Sign in with Aicoo";
    els.authButton.dataset.action = "signin";
    if (profileButton) profileButton.dataset.action = "signin";
    els.sidebarUserName.textContent = "Sign in required";
    els.sidebarUserHandle.textContent = "Aicoo identity";
    const profileImg = document.querySelector(".profile-button img");
    if (profileImg) {
      profileImg.src = "https://api.dicebear.com/9.x/pixel-art/png?seed=Yu";
    }
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
    els.heroDescription.textContent = "Events are Aicoo Square subsquares. People and projects publish Square cards backed by scoped agent context.";
    els.heroMeta.innerHTML = `
      <span>${state.events.length} events</span>
      <span>Aicoo Square API</span>
      <span>No frontend API keys</span>
    `;
    setPanel("events");
    renderEvents();
    renderPhone();
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
  els.heroEyebrow.textContent = `${event.type} · ${event.visibility}`;
  els.heroTitle.textContent = event.name;
  els.heroDescription.textContent = event.description;
  els.heroMeta.innerHTML = `
    <span>${event.date || "Date TBD"}</span>
    <span>${state.participants.length} people</span>
    <span>${state.projects.length} projects</span>
  `;
  setPanel(state.activeSection);
  renderPeople();
  renderProjects();
  renderPhone();
}

function renderEvents() {
  const events = state.events.filter(eventMatches);
  if (!events.length) {
    els.eventsGrid.innerHTML = `
      <div class="empty-state">
        <h3>No events loaded</h3>
        <p>No Square subsquares were returned. If you see an Aicoo API error, configure OAuth or a valid AICOO_API_KEY.</p>
      </div>
    `;
    return;
  }

  els.eventsGrid.innerHTML = events
    .map((event) => {
      const locked = event.visibility === "private" && event.accessCode && !state.unlocked.has(event.slug) && !state.unlocked.has(event.inviteToken);
      return `
        <article class="event-card ${event.visibility}" data-event-id="${event.slug}">
          <div class="card-top">
            <span class="tag">${event.type}</span>
            <span class="visibility">${locked ? "Private" : event.visibility === "private" ? "Unlocked" : "Public"}</span>
          </div>
          <h3>${event.name}</h3>
          <p>${event.description || ""}</p>
          <div class="hero-meta compact">
            <span>${event.date || "Date TBD"}</span>
            <span>${event.slug}</span>
          </div>
          <button class="primary-button wide" type="button" data-action="open-event" data-event-id="${event.slug}">
            ${locked ? "Unlock Event" : "Enter Event"}
          </button>
        </article>
      `;
    })
    .join("");
}

function renderPeople() {
  const people = state.participants.filter(personMatches);
  els.peopleGrid.innerHTML = people
    .map((person) => {
      const active = person.id === state.selectedPersonId ? " active" : "";
      return `
        <article class="person-card${active}" tabindex="0" data-person-id="${person.id}">
          <div class="card-top">
            <img class="avatar" src="${avatar(person.name)}" alt="${person.name} avatar" />
            <span class="online">Online</span>
          </div>
          <h3>${person.name}</h3>
          <div class="role">${person.role || ""}</div>
          <p>${person.intro || ""}</p>
          <div class="tag-row">${tagList(person.skills)}</div>
          <div class="tag-row">${tagList(person.lookingFor, "chip")}</div>
        </article>
      `;
    })
    .join("");
  renderParticipantDetail();
}

function renderParticipantDetail() {
  const person = state.participants.find((item) => item.id === state.selectedPersonId);
  if (!person) {
    els.participantDetail.innerHTML = `<h2>No participant selected</h2><p>Register to create the first Aicoo-backed card.</p>`;
    return;
  }
  els.participantDetail.innerHTML = `
    <div class="card-top">
      <img class="avatar" src="${avatar(person.name)}" alt="${person.name} avatar" />
      <span class="online">Online</span>
    </div>
    <h2>${person.name}</h2>
    <div class="role">${person.role || ""} · ${person.company || ""}</div>
    <p>${person.intro || ""}</p>
    <h3>Skills</h3>
    <div class="tag-row">${tagList(person.skills)}</div>
    <h3>Agent</h3>
    <p>${person.agentName || ""}</p>
    <div class="detail-actions">
      ${person.sharedAgentLink ? `<a class="primary-button link-button" href="${person.sharedAgentLink}" target="_blank" rel="noreferrer">Chat with Agent</a>` : ""}
      <button class="ghost-button" type="button" data-action="book" data-name="${person.name}">Book Meeting</button>
      ${person.sharedAgentLink ? `<button class="ghost-button" type="button" data-action="copy" data-link="${person.sharedAgentLink}">Copy Agent Link</button>` : ""}
    </div>
  `;
}

function renderProjects() {
  const projects = state.projects.filter(projectMatches);
  els.projectGrid.innerHTML = projects
    .map((project) => {
      const active = project.id === state.selectedProjectId ? " active" : "";
      return `
        <article class="project-card${active}" tabindex="0" data-project-id="${project.id}">
          <div class="project-art"></div>
          <div class="project-body">
            <span class="tag">${project.track || ""}</span>
            <h3>${project.projectName}</h3>
            <p>${project.oneLiner || ""}</p>
            <div class="author-row">${(project.authors || []).map((author) => `<img src="${avatar(author)}" alt="${author}" />`).join("")}</div>
          </div>
        </article>
      `;
    })
    .join("");
  renderProjectDetail();
}

function renderProjectDetail() {
  const project = state.projects.find((item) => item.id === state.selectedProjectId);
  if (!project) {
    els.projectDetail.innerHTML = `<h2>No project selected</h2><p>Submit a project to create the first project-specific Aicoo agent.</p>`;
    return;
  }
  els.projectDetail.innerHTML = `
    <span class="tag">${project.track || ""}</span>
    <h2>${project.projectName}</h2>
    <p>${project.oneLiner || ""}</p>
    <h3>Description</h3>
    <p>${project.description || ""}</p>
    <h3>Project Agent</h3>
    <p>${project.projectAgentName || ""}</p>
    <h3>Authors</h3>
    <div class="tag-row">${tagList(project.authors)}</div>
    <div class="detail-actions">
      ${project.sharedProjectAgentLink ? `<a class="primary-button link-button" href="${project.sharedProjectAgentLink}" target="_blank" rel="noreferrer">Chat with Project Agent</a>` : ""}
      ${project.demoUrl ? `<a class="ghost-button link-button" href="${project.demoUrl}" target="_blank" rel="noreferrer">Open Demo</a>` : ""}
      ${project.githubUrl ? `<a class="ghost-button link-button" href="${project.githubUrl}" target="_blank" rel="noreferrer">GitHub</a>` : ""}
    </div>
  `;
}

function renderPhone() {
  els.phoneTitle.textContent = state.activeEvent ? state.activeEvent.name : "Events Square";
  const source = state.activeEvent ? state.participants : state.events;
  els.phonePeople.innerHTML = source
    .slice(0, 6)
    .map((item) => `<div class="phone-person"><img src="${avatar(item.name || item.slug)}" alt="" /></div>`)
    .join("");
}

function openAccessModal(event) {
  state.pendingPrivateEvent = event;
  els.accessTitle.textContent = `Unlock ${event.name}`;
  els.accessCopy.textContent = "This event is private. Enter its access code or open with its invite token.";
  els.accessCodeInput.value = "";
  els.accessModal.classList.remove("hidden");
  els.accessCodeInput.focus();
}

function closeAccessModal() {
  state.pendingPrivateEvent = null;
  els.accessModal.classList.add("hidden");
}

async function enterEvent(event) {
  state.currentView = "event";
  state.activeEvent = event;
  state.activeSection = "people";
  state.query = "";
  els.search.value = "";
  closeAccessModal();
  await loadEventData(event);
}

function attemptOpenEvent(slug) {
  const event = state.events.find((item) => item.slug === slug);
  if (!event) return;
  if (!state.connected) {
    showToast("Connect Aicoo before entering event squares");
    return;
  }
  const locked = event.visibility === "private" && event.accessCode && !state.unlocked.has(event.slug) && !state.unlocked.has(event.inviteToken);
  if (locked) {
    openAccessModal(event);
    return;
  }
  enterEvent(event);
}

function applyInviteFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const queryInvite = params.get("invite");
  const hashInvite = window.location.hash.startsWith("#invite=") ? window.location.hash.replace("#invite=", "") : "";
  const invite = queryInvite || hashInvite;
  if (invite) {
    state.unlocked.add(invite);
    showToast("Invite token loaded");
  }
}

function bindEvents() {
  document.addEventListener("click", async (event) => {
    const action = event.target.closest("[data-action]");
    if (action) {
      const type = action.dataset.action;
      if (type === "signin") await connectAicoo();
      if (type === "signout") signoutAicoo();
      if (type === "back-events") {
        state.currentView = "events";
        state.activeEvent = null;
        state.query = "";
        els.search.value = "";
        renderShell();
      }
      if (type === "toggle-create-event") els.createEventPanel.classList.toggle("hidden");
      if (type === "open-event") attemptOpenEvent(action.dataset.eventId);
      if (type === "close-access") closeAccessModal();
      if (type === "toggle-register") els.registerPanel.classList.toggle("hidden");
      if (type === "toggle-submit") els.submitPanel.classList.toggle("hidden");
      if (type === "copy") {
        await navigator.clipboard.writeText(action.dataset.link);
        showToast("Link copied");
      }
      if (type === "book") showToast(`Meeting flow opened for ${action.dataset.name}`);
    }

    const sectionButton = event.target.closest("[data-section]");
    if (sectionButton) {
      state.activeSection = sectionButton.dataset.section;
      renderShell();
    }

    const personCard = event.target.closest("[data-person-id]");
    if (personCard && !event.target.closest("[data-action]")) {
      state.selectedPersonId = personCard.dataset.personId;
      renderPeople();
    }

    const projectCard = event.target.closest("[data-project-id]");
    if (projectCard) {
      state.selectedProjectId = projectCard.dataset.projectId;
      renderProjects();
    }
  });

  document.querySelectorAll("[data-filter-group='events'] button").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-filter-group='events'] button").forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      state.eventFilter = button.dataset.filter;
      renderEvents();
    });
  });

  els.search.addEventListener("input", (event) => {
    state.query = event.target.value;
    if (state.currentView === "events") renderEvents();
    if (state.currentView === "event") {
      renderPeople();
      renderProjects();
    }
  });

  els.accessForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const target = state.pendingPrivateEvent;
    if (!target || normalize(els.accessCodeInput.value) !== normalize(target.accessCode)) {
      showToast("Wrong access code");
      return;
    }
    state.unlocked.add(target.slug);
    state.unlocked.add(target.inviteToken);
    enterEvent(target);
  });

  els.createEventForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = Object.fromEntries(new FormData(els.createEventForm));
      await api("/api/events", { method: "POST", body: JSON.stringify(body) });
      els.createEventPanel.classList.add("hidden");
      showToast("Event announcement posted to Aicoo Square");
      await loadEvents();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  });

  els.registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = Object.fromEntries(new FormData(els.registerForm));
      body.skills = csv(body.skills);
      body.lookingFor = csv(body.lookingFor);
      body.lookingForTeam = body.lookingForTeam === "on";
      const data = await api(`/api/events/${state.activeEvent.slug}/participants`, { method: "POST", body: JSON.stringify(body) });
      state.participants.unshift(data.participant);
      state.selectedPersonId = data.participant.id;
      els.generatedParticipant.innerHTML = `<h3>${data.participant.name}</h3><p>${data.participant.role || ""}</p><div class="tag-row">${tagList(data.participant.skills)}</div>`;
      els.registerSuccess.classList.remove("hidden");
      showToast("Participant card and Aicoo agent link created");
      renderShell();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  });

  els.submitForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    setBusy(true);
    try {
      const body = Object.fromEntries(new FormData(els.submitForm));
      body.authors = csv(body.authors);
      const data = await api(`/api/events/${state.activeEvent.slug}/projects`, { method: "POST", body: JSON.stringify(body) });
      state.projects.unshift(data.project);
      state.selectedProjectId = data.project.id;
      els.generatedSubmission.innerHTML = `<h3>${data.project.projectName}</h3><p>${data.project.oneLiner || ""}</p><span class="tag">${data.project.track || ""}</span><p>${data.project.projectAgentName || ""}</p>`;
      els.submitSuccess.classList.remove("hidden");
      showToast("Project and project-specific Aicoo agent created");
      renderShell();
    } catch (error) {
      showError(error);
    } finally {
      setBusy(false);
    }
  });
}

async function initApp() {
  applyInviteFromUrl();
  bindEvents();
  
  const savedToken = localStorage.getItem("aicoo_token");
  const savedUser = localStorage.getItem("aicoo_user");
  if (savedToken) {
    state.connected = true;
    try {
      state.user = savedUser ? JSON.parse(savedUser) : null;
    } catch {
      state.user = null;
    }
  }
  
  renderShell();
  
  const params = new URLSearchParams(window.location.search);
  if (params.has("code")) {
    await handleOAuthCallback();
  } else {
    await loadEvents();
  }
}

initApp();
