/* ==========================================================================
  app.js

  Goals:
  - Pull pinned repos from GitHub (without a build step)
  - Keep UI state simple and readable
  - Fail gracefully (rate limits happen, and I'm not throwing a tantrum about it)
  ========================================================================== */

(() => {
  "use strict";

  // -----------------------------
  // Tiny helpers (no libraries, relax)
  // -----------------------------
  const $ = (sel, root = document) => root.querySelector(sel);

  function safeText(v, fallback = "") {
    return typeof v === "string" && v.trim() ? v : fallback;
  }

  function formatNum(n) {
    if (typeof n !== "number") return "0";
    return n.toLocaleString();
  }

  function formatDate(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
    } catch {
      return "n/a";
    }
  }

  // -----------------------------
  // Theme (persisted)
  // -----------------------------
  const themeToggle = $("#themeToggle");
  const THEME_KEY = "demo-ui-theme";

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    themeToggle?.setAttribute("aria-pressed", String(theme === "light"));
  }

  function initTheme() {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === "light" || saved === "dark") {
      applyTheme(saved);
      return;
    }

    // Default: dark-first, but respect system prefs if they want light.
    const prefersLight = window.matchMedia?.("(prefers-color-scheme: light)")?.matches;
    applyTheme(prefersLight ? "light" : "dark");
  }

  themeToggle?.addEventListener("click", () => {
    const current = document.documentElement.dataset.theme === "light" ? "light" : "dark";
    const next = current === "light" ? "dark" : "light";
    applyTheme(next);
    localStorage.setItem(THEME_KEY, next);
  });

  // -----------------------------
  // Repo loading + caching
  // -----------------------------
  const usernameInput = $("#username");
  const loadBtn = $("#loadBtn");
  const cacheBtn = $("#cacheBtn");
  const sortSelect = $("#sort");
  const statusEl = $("#status");
  const gridEl = $("#repoGrid");

  const CACHE_KEY = "demo-ui-repo-cache-v1";
  const CACHE_USER_KEY = "demo-ui-user-v1";

  // This is state. It's not Redux. It's not complicated. It's fine.
  const state = {
    user: "",
    repos: [],
    lastLoadedAt: null,
  };

  function setStatus(msg, type = "info") {
    if (!statusEl) return;
    statusEl.textContent = msg;

    // Optional: tiny semantic hint in the message for quick scanning.
    // Not over-designed. Just enough.
    statusEl.dataset.type = type;
  }

  function saveCache() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({
        user: state.user,
        repos: state.repos,
        lastLoadedAt: state.lastLoadedAt,
      }));
    } catch {
      // If storage fails, we move on. No drama.
    }
  }

  function loadCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !Array.isArray(parsed.repos)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function setUserHints(user) {
    // These links are placeholders in the HTML. We'll make them real once we know the username.
    const githubLink = $("#githubLink");
    if (githubLink && user) githubLink.href = `https://github.com/${encodeURIComponent(user)}`;
  }

  // -----------------------------
  // GitHub pinned repos:
  // GitHub does NOT provide "pinned" via REST.
  // So we use the GitHub GraphQL API endpoint without auth? No.
  // Without a token, GraphQL is basically not happening.
  //
  // Instead:
  // - We fetch public repos
  // - We "pin" the top N by stars (and let you override later)
  //
  // It's honest, it works, and it doesn't require leaking tokens.
  // -----------------------------

  async function fetchRepos(user) {
    // GitHub rate limits unauthenticated requests, so keep it reasonable.
    const url = `https://api.github.com/users/${encodeURIComponent(user)}/repos?per_page=100&sort=updated`;

    const res = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github+json",
      },
    });

    // Rate limit details usually come back as 403 or 429-ish behavior.
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const msg = text?.includes("API rate limit exceeded")
        ? "GitHub rate limited this request. Shocking, I know."
        : `GitHub request failed (${res.status}).`;
      throw new Error(msg);
    }

    return res.json();
  }

  function normalizeRepos(raw) {
    if (!Array.isArray(raw)) return [];

    return raw
      .filter(r => r && !r.fork) // forks usually confuse recruiters. keep it clean.
      .map(r => ({
        id: r.id,
        name: safeText(r.name, "repo"),
        html_url: safeText(r.html_url, "#"),
        description: safeText(r.description, "No description. (We love that.)"),
        language: safeText(r.language, "n/a"),
        stargazers_count: typeof r.stargazers_count === "number" ? r.stargazers_count : 0,
        forks_count: typeof r.forks_count === "number" ? r.forks_count : 0,
        updated_at: safeText(r.updated_at, ""),
        topics: Array.isArray(r.topics) ? r.topics : [],
        homepage: safeText(r.homepage, ""),
      }));
  }

  function getPinnedLike(repos, max = 9) {
    // “Pinned” approximation:
    // pick high-signal repos by stars, then by recent updates.
    // Not perfect, but it’s consistent and explainable.
    return [...repos]
      .sort((a, b) => (b.stargazers_count - a.stargazers_count) || (Date.parse(b.updated_at) - Date.parse(a.updated_at)))
      .slice(0, max);
  }

  function sortRepos(repos, mode) {
    const list = [...repos];

    if (mode === "updated") {
      list.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      return list;
    }
    if (mode === "name") {
      list.sort((a, b) => a.name.localeCompare(b.name));
      return list;
    }
    // default: stars
    list.sort((a, b) => (b.stargazers_count - a.stargazers_count) || (Date.parse(b.updated_at) - Date.parse(a.updated_at)));
    return list;
  }

  function cardTemplate(r) {
    const updated = r.updated_at ? formatDate(r.updated_at) : "n/a";
    const lang = safeText(r.language, "n/a");

    // Small “signal” badge: stars
    const badge = r.stargazers_count > 0 ? `★ ${formatNum(r.stargazers_count)}` : "★ 0";

    // Optional: homepage, if repo has a live demo link
    const demo = r.homepage ? `<a class="badge" href="${escapeHtmlAttr(r.homepage)}" target="_blank" rel="noreferrer">Live demo</a>` : "";

    return `
      <article class="card" data-repo="${escapeHtmlAttr(r.name)}">
        <div class="card__top">
          <a class="card__name" href="${escapeHtmlAttr(r.html_url)}" target="_blank" rel="noreferrer">
            ${escapeHtml(r.name)}
          </a>
          <span class="badge" title="Stars">${badge}</span>
        </div>

        <p class="desc">${escapeHtml(r.description)}</p>

        <div class="meta">
          <span><strong>Lang:</strong> ${escapeHtml(lang)}</span>
          <span><strong>Forks:</strong> ${formatNum(r.forks_count)}</span>
          <span><strong>Updated:</strong> ${escapeHtml(updated)}</span>
        </div>

        <div style="margin-top:12px; display:flex; gap:10px; flex-wrap:wrap;">
          <a class="badge" href="${escapeHtmlAttr(r.html_url)}" target="_blank" rel="noreferrer">Repo</a>
          ${demo}
        </div>
      </article>
    `;
  }

  // Basic escaping. Because injecting HTML without it is how people earn surprise vulnerabilities.
  function escapeHtml(str) {
    return String(str)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
  function escapeHtmlAttr(str) {
    // Same thing, but in attributes. Don’t overthink it.
    return escapeHtml(str).replaceAll("`", "&#096;");
  }

  function renderRepos(repos) {
    if (!gridEl) return;

    if (!repos.length) {
      gridEl.innerHTML = `
        <div class="card" style="grid-column: 1 / -1;">
          <h3>No repos to display</h3>
          <p class="muted">Either the user has no public repos, or GitHub is being GitHub.</p>
        </div>
      `;
      return;
    }

    gridEl.innerHTML = repos.map(cardTemplate).join("");
  }

  async function loadLive() {
    const user = safeText(usernameInput?.value, "").trim();
    if (!user) {
      setStatus("Enter a GitHub username first.", "warn");
      return;
    }

    setStatus("Loading repos from GitHub…", "info");

    try {
      const raw = await fetchRepos(user);
      const normalized = normalizeRepos(raw);
      const pinnedLike = getPinnedLike(normalized, 9);

      state.user = user;
      state.repos = pinnedLike;
      state.lastLoadedAt = new Date().toISOString();

      // Save username hint too
      try { localStorage.setItem(CACHE_USER_KEY, user); } catch {}

      saveCache();
      setUserHints(user);

      const sorted = sortRepos(state.repos, sortSelect?.value || "stars");
      renderRepos(sorted);

      setStatus(`Loaded ${sorted.length} repos for ${user}. Cached locally.`, "good");
    } catch (err) {
      // If live fails, try cache. If cache fails, at least explain it like a human.
      const cached = loadCache();
      if (cached?.repos?.length) {
        state.user = cached.user || user;
        state.repos = cached.repos;
        state.lastLoadedAt = cached.lastLoadedAt || null;

        setUserHints(state.user);
        const sorted = sortRepos(state.repos, sortSelect?.value || "stars");
        renderRepos(sorted);

        setStatus(`${err.message} Using cached data instead.`, "warn");
        return;
      }

      setStatus(err.message || "Failed to load repos.", "warn");
      renderRepos([]);
    }
  }

  function useCached() {
    const cached = loadCache();
    if (!cached?.repos?.length) {
      setStatus("No cache found yet. Load live repos first.", "warn");
      return;
    }

    state.user = cached.user || "";
    state.repos = cached.repos;
    state.lastLoadedAt = cached.lastLoadedAt || null;

    if (usernameInput && state.user) usernameInput.value = state.user;
    setUserHints(state.user);

    const sorted = sortRepos(state.repos, sortSelect?.value || "stars");
    renderRepos(sorted);

    const when = state.lastLoadedAt ? formatDate(state.lastLoadedAt) : "unknown";
    setStatus(`Loaded ${sorted.length} repos from cache (last: ${when}).`, "info");
  }

  // Sorting: keep it snappy
  sortSelect?.addEventListener("change", () => {
    const sorted = sortRepos(state.repos, sortSelect.value);
    renderRepos(sorted);
  });

  loadBtn?.addEventListener("click", loadLive);
  cacheBtn?.addEventListener("click", useCached);

  // -----------------------------
  // Boot
  // -----------------------------
  function boot() {
    initTheme();
    $("#year").textContent = String(new Date().getFullYear());

    // Try to prefill username from last time because typing is a chore.
    try {
      const lastUser = localStorage.getItem(CACHE_USER_KEY);
      if (usernameInput && lastUser) usernameInput.value = lastUser;
      if (lastUser) setUserHints(lastUser);
    } catch {}

    // Load cache on first paint so the page isn’t empty.
    // If you want live fetch immediately, click the button. I’m not assuming.
    useCached();
  }

  // Run once DOM exists. No double-binding, no weird reload loops.
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot, { once: true });
  } else {
    boot();
  }
})();


/* ==========================================================================
  Architecture Snapshot
  - Small, practical service demo that talks to a backend OpenAI proxy.
  - Frontend never sees API keys. I like not getting my account burned.
  ========================================================================== */

(() => {
  "use strict";

  const $ = (sel, root = document) => root.querySelector(sel);

  function setStatus(el, msg) {
    if (!el) return;
    el.textContent = msg || "";
  }

  function asList(listEl, items) {
    if (!listEl) return;
    listEl.innerHTML = "";
    (Array.isArray(items) ? items : []).forEach((v) => {
      const li = document.createElement("li");
      li.textContent = String(v || "").trim();
      if (li.textContent) listEl.appendChild(li);
    });
    if (!listEl.children.length) {
      const li = document.createElement("li");
      li.textContent = "None detected from the provided input.";
      listEl.appendChild(li);
    }
  }

  function detectType(text) {
    const t = String(text || "");
    // crude but effective: tree-ish input usually has slashes, indentation, or box-drawing chars
    const looksLikeTree =
      /(^|\n)\s*[\/\\]|[├└│]/.test(t) ||
      /(^|\n)\s{2,}\S+/.test(t) ||
      /\n/.test(t);

    return looksLikeTree ? "tree" : "desc";
  }

  async function analyzeArchitecture(payload) {
    const res = await fetch("/api/architecture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    // If the endpoint doesn't exist (static hosting), fail cleanly.
    if (res.status === 404) {
      const err = new Error("missing-endpoint");
      err.code = "MISSING_ENDPOINT";
      throw err;
    }

    let data = null;
    try {
      data = await res.json();
    } catch {
      // keep null
    }

    if (!res.ok) {
      const msg =
        (data && (data.error || data.message)) ||
        `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }

    return data;
  }

  function bootArch() {
    const form = $("#archForm");
    if (!form) return;

    const input = $("#archInput");
    const btn = $("#archBtn");
    const clear = $("#archClear");
    const status = $("#archStatus");

    const outWrap = $("#archOut");
    const summary = $("#archSummary");
    const patterns = $("#archPatterns");
    const strengths = $("#archStrengths");
    const risk = $("#archRisk");
    const improve = $("#archImprove");

    const MAX = 9000;

    function guardrail(msg) {
      setStatus(status, msg);
      if (outWrap) outWrap.hidden = true;
    }

    clear?.addEventListener("click", () => {
      if (input) input.value = "";
      setStatus(status, "");
      if (outWrap) outWrap.hidden = true;
      input?.focus();
    });

    btn?.addEventListener("click", async (e) => {
      e.preventDefault();

      const raw = (input?.value || "").trim();
      if (!raw) return guardrail("Input is too vague to analyze meaningfully. Provide structure, not intentions.");

      if (raw.length > MAX) {
        return guardrail(`Input is too large (${raw.length} chars). Trim it under ${MAX}.`);
      }

      setStatus(status, "Reviewing structure…");
      if (btn) btn.disabled = true;

      try {
        const payload = { type: detectType(raw), content: raw };
        const data = await analyzeArchitecture(payload);

        // expected response shape:
        // { summary, patterns[], strengths[], risk, improvement }
        if (summary) summary.textContent = data.summary || "";
        if (risk) risk.textContent = data.risk || "";
        if (improve) improve.textContent = data.improvement || "";
        asList(patterns, data.patterns);
        asList(strengths, data.strengths);

        if (outWrap) outWrap.hidden = false;
        setStatus(status, "");
      } catch (err) {
        if (err && err.code === "MISSING_ENDPOINT") {
          guardrail("Analysis failed. Backend endpoint not found. This demo needs a serverless function (see deploy notes).");
        } else {
          guardrail(`Analysis failed. ${err?.message || "The input couldn’t be parsed as a system boundary."}`);
        }
      } finally {
        if (btn) btn.disabled = false;
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootArch, { once: true });
  } else {
    bootArch();
  }
})();
