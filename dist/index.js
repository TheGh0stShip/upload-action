// src/main.ts
import { execFileSync } from "node:child_process";
import { readFile as readFile2 } from "node:fs/promises";
import { extname } from "node:path";
import { gzipSync } from "node:zlib";

// ../decomp-api/src/upload.ts
var round2 = (n) => Math.round(n * 100) / 100;
function summarizeFunctions(raw) {
  const out = [];
  for (const f of raw ?? []) {
    const size = Number(f.size ?? 0) || 0;
    if (size > 0) out.push([f.metadata?.demangled_name ?? f.name, size, round2(Number(f.fuzzy_match_percent ?? 0) || 0)]);
  }
  return out;
}
function summarizeReport(report) {
  return {
    measures: normalizeMeasures(report.measures),
    categories: (report.categories ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      measures: normalizeMeasures(c.measures)
    })),
    units: (report.units ?? []).map((u) => {
      const m = normalizeMeasures(u.measures);
      const functions = summarizeFunctions(u.functions);
      return {
        name: u.name,
        size: m.total_code,
        fuzzy: round2(m.fuzzy_match_percent),
        complete: Boolean(u.metadata?.complete),
        categories: u.metadata?.progress_categories ?? [],
        ...functions.length ? { functions } : {}
      };
    }).filter((u) => u.size > 0)
  };
}

// ../decomp-api/src/client.ts
var MEASURE_KEYS = [
  "fuzzy_match_percent",
  "total_code",
  "matched_code",
  "matched_code_percent",
  "total_data",
  "matched_data",
  "matched_data_percent",
  "total_functions",
  "matched_functions",
  "matched_functions_percent",
  "complete_code",
  "complete_code_percent",
  "complete_data",
  "complete_data_percent",
  "total_units",
  "complete_units"
];
function normalizeMeasures(raw) {
  const out = {};
  for (const key of MEASURE_KEYS) out[key] = Number(raw?.[key] ?? 0) || 0;
  return out;
}

// ../decomp-api/src/format.ts
function formatPercent(value, digits = 2) {
  return `${value.toFixed(digits)}%`;
}
function formatCount(n) {
  return n.toLocaleString("en-US");
}
var RTF = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
var STEPS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60]
];

// ../decomp-api/src/game.ts
var PLATFORMS = [
  { id: "gbc", name: "Game Boy Color", short: "GBC", maker: "Nintendo", year: 1998, cpu: "Sharp SM83" },
  { id: "n64", name: "Nintendo 64", short: "N64", maker: "Nintendo", year: 1996, cpu: "MIPS VR4300" },
  { id: "ps", name: "PlayStation", short: "PS1", maker: "Sony", year: 1994, cpu: "MIPS R3000A" },
  { id: "gba", name: "Game Boy Advance", short: "GBA", maker: "Nintendo", year: 2001, cpu: "ARM7TDMI" },
  { id: "gc", name: "GameCube", short: "GCN", maker: "Nintendo", year: 2001, cpu: "PowerPC Gekko" },
  { id: "ps2", name: "PlayStation 2", short: "PS2", maker: "Sony", year: 2e3, cpu: "MIPS R5900" },
  { id: "xbox", name: "Xbox", short: "XBOX", maker: "Microsoft", year: 2001, cpu: "x86 Pentium III" },
  { id: "nds", name: "Nintendo DS", short: "NDS", maker: "Nintendo", year: 2004, cpu: "ARM946E-S" },
  { id: "psp", name: "PlayStation Portable", short: "PSP", maker: "Sony", year: 2004, cpu: "MIPS Allegrex" },
  { id: "xbox360", name: "Xbox 360", short: "X360", maker: "Microsoft", year: 2005, cpu: "PowerPC Xenon" },
  { id: "wii", name: "Wii", short: "WII", maker: "Nintendo", year: 2006, cpu: "PowerPC Broadway" },
  { id: "3ds", name: "Nintendo 3DS", short: "3DS", maker: "Nintendo", year: 2011, cpu: "ARM11 MPCore" },
  { id: "switch", name: "Nintendo Switch", short: "NSW", maker: "Nintendo", year: 2017, cpu: "ARM Cortex-A57" },
  { id: "win32", name: "Windows", short: "PC", maker: "Microsoft", year: 1995, cpu: "x86" }
];
var BY_ID = new Map(PLATFORMS.map((p) => [p.id, p]));

// src/inputs.ts
var DEFAULTS = {
  "fail-on-regression": "false",
  comments: "decmp-comment",
  "api-url": "https://api.decmp.dev"
};
function actionVariable(name) {
  return `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
}
function scriptVariable(name) {
  return `DECMP_${name.replace(/[ -]/g, "_").toUpperCase()}`;
}
function readInput(name, required = false, env = process.env) {
  const fallback = name === "github-token" ? env.GITHUB_TOKEN : DEFAULTS[name];
  const value = (env[actionVariable(name)]?.trim() || env[scriptVariable(name)]?.trim() || fallback?.trim()) ?? "";
  if (required && !value) throw new Error(`input "${name}" is required (${scriptVariable(name)} in a run step)`);
  return value;
}

// src/pr.ts
import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

// src/compare.ts
var LIST_LIMIT = 25;
var COMMENT_LIMIT = 6e4;
var SAME = (a, b) => Math.abs(a - b) < 1e-9;
function measuresEqual(a, b) {
  return Object.keys(a).every((k) => SAME(a[k], b[k]));
}
function functionMap(unit) {
  const out = /* @__PURE__ */ new Map();
  for (const [name, , fuzzy] of unit?.functions ?? []) {
    let key = name;
    for (let n = 2; out.has(key); n++) key = `${name}#${n}`;
    out.set(key, fuzzy);
  }
  return out;
}
function compareUnits(before, after) {
  const old = new Map(before.map((u) => [u.name, u]));
  const out = {
    matched: [],
    regressed: [],
    matched_count: 0,
    regressed_count: 0,
    improved_count: 0,
    worsened_count: 0,
    units_matched: [],
    units_regressed: [],
    units_matched_count: 0,
    units_regressed_count: 0
  };
  for (const unit of after) {
    const prev = old.get(unit.name);
    if (prev && prev.fuzzy < 100 && unit.fuzzy >= 100) out.units_matched.push(unit.name);
    if (prev && prev.fuzzy >= 100 && unit.fuzzy < 100) out.units_regressed.push(unit.name);
    const was = functionMap(prev);
    for (const [key, fuzzy] of functionMap(unit)) {
      const b = was.get(key);
      if (b === void 0 || SAME(b, fuzzy)) continue;
      const change = { unit: unit.name, name: key.replace(/#\d+$/, ""), before: b, after: fuzzy };
      if (fuzzy >= 100) out.matched.push(change);
      else if (b >= 100) out.regressed.push(change);
      else if (fuzzy > b) out.improved_count++;
      else out.worsened_count++;
    }
  }
  out.matched_count = out.matched.length;
  out.regressed_count = out.regressed.length;
  out.regressed.sort((a, b) => a.after - b.after || a.unit.localeCompare(b.unit) || a.name.localeCompare(b.name));
  out.matched.sort((a, b) => a.unit.localeCompare(b.unit) || a.name.localeCompare(b.name));
  out.matched.length = Math.min(out.matched.length, LIST_LIMIT);
  out.regressed.length = Math.min(out.regressed.length, LIST_LIMIT);
  out.units_matched_count = out.units_matched.length;
  out.units_regressed_count = out.units_regressed.length;
  out.units_matched = out.units_matched.sort().slice(0, LIST_LIMIT);
  out.units_regressed = out.units_regressed.sort().slice(0, LIST_LIMIT);
  return out;
}
function compareCategories(before, after) {
  const old = new Map(before.map((c) => [c.id, c]));
  const out = [];
  for (const c of after) {
    const prev = old.get(c.id);
    old.delete(c.id);
    if (!prev || !measuresEqual(prev.measures, c.measures)) {
      out.push({ id: c.id, name: c.name, before: prev?.measures ?? null, after: c.measures });
    }
  }
  for (const c of old.values()) out.push({ id: c.id, name: c.name, before: c.measures, after: null });
  return out;
}
function hasRegression(c) {
  const b = c.before;
  const a = c.after;
  if (b && (a.matched_code < b.matched_code || a.matched_data < b.matched_data)) return true;
  if (b && (a.matched_functions < b.matched_functions || a.complete_units < b.complete_units)) return true;
  return Boolean(c.units && (c.units.regressed_count > 0 || c.units.units_regressed_count > 0));
}
function hasChanges(c) {
  if (!c.before) return true;
  if (!measuresEqual(c.before, c.after) || c.categories.length) return true;
  const u = c.units;
  return Boolean(u && (u.matched_count || u.regressed_count || u.improved_count || u.worsened_count));
}
function markerOf(version) {
  return `<!-- decmp-progress:${cleanVersion(version)} -->`;
}
function cleanVersion(version) {
  return version.replace(/[^\w.-]/g, "_").replace(/-{2,}/g, "-").slice(0, 64);
}
function plain(text) {
  let out = "";
  for (const ch of text.slice(0, 200)) out += ch < " " || ch === "\x7F" ? " " : ch;
  return out;
}
function escapeText(text) {
  return plain(text).replace(/[\\`*_{}[\]()<>#+!|~&]/g, (ch) => `\\${ch}`);
}
function code(text) {
  const clean = plain(text).replace(/`/g, "'");
  return `\`${clean}\``;
}
var pct = (n) => formatPercent(n);
function signed(n, format) {
  if (SAME(n, 0)) return format(0);
  return n > 0 ? `+${format(n)}` : `\u2212${format(-n)}`;
}
var bold = (text, loss) => loss ? `**${text}**` : text;
function delta(n, format) {
  return bold(signed(n, format), n < 0 && !SAME(n, 0));
}
function percentDelta(before, after, bytes) {
  const d = Math.round(after * 100) / 100 - Math.round(before * 100) / 100;
  if (SAME(bytes, 0)) return delta(d, pct);
  return bold(`${signed(d, pct)} (${signed(bytes, formatCount)} B)`, bytes < 0 || d < 0 && !SAME(d, 0));
}
function measureRows(b, a) {
  const dash = "\u2013";
  return [
    [
      "Matched code",
      b ? pct(b.matched_code_percent) : dash,
      pct(a.matched_code_percent),
      b ? percentDelta(b.matched_code_percent, a.matched_code_percent, a.matched_code - b.matched_code) : dash
    ],
    [
      "Matched data",
      b ? pct(b.matched_data_percent) : dash,
      pct(a.matched_data_percent),
      b ? percentDelta(b.matched_data_percent, a.matched_data_percent, a.matched_data - b.matched_data) : dash
    ],
    [
      "Matched functions",
      b ? `${formatCount(b.matched_functions)} / ${formatCount(b.total_functions)}` : dash,
      `${formatCount(a.matched_functions)} / ${formatCount(a.total_functions)}`,
      b ? delta(a.matched_functions - b.matched_functions, formatCount) : dash
    ],
    [
      "Complete units",
      b ? `${formatCount(b.complete_units)} / ${formatCount(b.total_units)}` : dash,
      `${formatCount(a.complete_units)} / ${formatCount(a.total_units)}`,
      b ? delta(a.complete_units - b.complete_units, formatCount) : dash
    ],
    [
      "Fuzzy match",
      b ? pct(b.fuzzy_match_percent) : dash,
      pct(a.fuzzy_match_percent),
      b ? delta(Math.round(a.fuzzy_match_percent * 100) / 100 - Math.round(b.fuzzy_match_percent * 100) / 100, pct) : dash
    ]
  ];
}
function table(head, align, rows) {
  return [`| ${head.join(" | ")} |`, `|${align.join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}
var short = (sha) => sha.slice(0, 7);
function baseLine(c) {
  const { kind, sha, requested_sha } = c.base;
  const at = sha ? code(short(sha)) : "";
  switch (kind) {
    case "base":
      return `Compared with the base commit ${at}.`;
    case "merge-base":
      return `Compared with the merge base ${at}; the base commit ${code(short(requested_sha))} has no report.`;
    case "latest":
      return `Compared with the latest report, ${at}; the base commit ${code(short(requested_sha))} has no report.`;
    case "none":
      return `${escapeText(c.version)} has no report on decmp yet, so there is nothing to compare with.`;
  }
}
function functionList(title, list, count2) {
  if (!count2) return [];
  const lines = list.map((f) => `- ${code(f.name)} in ${code(f.unit)}: ${pct(f.before)} \u2192 ${pct(f.after)}`);
  if (count2 > list.length) lines.push(`- \u2026and ${formatCount(count2 - list.length)} more`);
  return [`**${title}** (${formatCount(count2)})`, "", ...lines, ""];
}
function unitList(title, list, count2) {
  if (!count2) return [];
  const lines = list.map((u) => `- ${code(u)}`);
  if (count2 > list.length) lines.push(`- \u2026and ${formatCount(count2 - list.length)} more`);
  return [`**${title}** (${formatCount(count2)})`, "", ...lines, ""];
}
function unitDetails(u) {
  const parts = [];
  if (u.matched_count) parts.push(`${formatCount(u.matched_count)} matched`);
  if (u.regressed_count) parts.push(`${formatCount(u.regressed_count)} regressed`);
  if (u.improved_count) parts.push(`${formatCount(u.improved_count)} improved`);
  if (u.worsened_count) parts.push(`${formatCount(u.worsened_count)} worse`);
  if (!parts.length && !u.units_matched_count && !u.units_regressed_count) return [];
  const body = [
    ...functionList("Regressed functions", u.regressed, u.regressed_count),
    ...unitList("Units no longer fully matched", u.units_regressed, u.units_regressed_count),
    ...functionList("Newly matched functions", u.matched, u.matched_count),
    ...unitList("Newly matched units", u.units_matched, u.units_matched_count)
  ];
  if (u.improved_count || u.worsened_count) {
    body.push(
      `${count(u.improved_count, "other function")} improved and ${formatCount(u.worsened_count)} got worse, without reaching or leaving 100%.`,
      ""
    );
  }
  return [`<details><summary>Functions: ${parts.join(", ") || "no change"}</summary>`, "", ...body, "</details>", ""];
}
function categoryDetails(list) {
  if (!list.length) return [];
  const rows = list.map((c) => {
    const b = c.before;
    const a = c.after;
    const name = escapeText(c.name || c.id);
    if (!a) return [name, b ? pct(b.matched_code_percent) : "\u2013", "removed", "\u2013", "\u2013"];
    return [
      name,
      b ? pct(b.matched_code_percent) : "new",
      pct(a.matched_code_percent),
      b ? percentDelta(b.matched_code_percent, a.matched_code_percent, a.matched_code - b.matched_code) : "\u2013",
      b ? delta(a.matched_functions - b.matched_functions, formatCount) : formatCount(a.matched_functions)
    ];
  });
  const n = list.length;
  return [
    `<details><summary>Categories (${n} changed)</summary>`,
    "",
    table(["Category", "Before", "After", "\u0394 code", "\u0394 functions"], [":---", "---:", "---:", "---:", "---:"], rows),
    "",
    "</details>",
    ""
  ];
}
function count(n, noun) {
  return `${formatCount(n)} ${noun}${n === 1 ? "" : "s"}`;
}
function regressionNote(c) {
  const b = c.before;
  const a = c.after;
  const lost = [];
  if (b && a.matched_code < b.matched_code) lost.push(`${formatCount(b.matched_code - a.matched_code)} B of matched code`);
  if (b && a.matched_data < b.matched_data) lost.push(`${formatCount(b.matched_data - a.matched_data)} B of matched data`);
  const functions = c.units?.regressed_count || (b ? b.matched_functions - a.matched_functions : 0);
  if (functions > 0) lost.push(count(functions, "matched function"));
  if (b && a.complete_units < b.complete_units) lost.push(count(b.complete_units - a.complete_units, "complete unit"));
  if (c.units?.units_regressed_count && !lost.length) lost.push(count(c.units.units_regressed_count, "fully matched unit"));
  return ["> [!WARNING]", `> This pull request loses ${lost.join(", ")}.`, ""];
}
function projectUrl(site, repository, version) {
  return `${site.replace(/\/$/, "")}/${repository}?version=${encodeURIComponent(version)}`;
}
function renderComment(c, link, marker = true) {
  const version = escapeText(c.version);
  const head = [...marker ? [markerOf(c.version)] : [], `### decmp progress for ${version}`, ""];
  if (c.base.kind !== "none" && !hasChanges(c)) {
    return [...head, `No change in progress against ${code(short(c.base.sha ?? ""))}. [Project page](${link})`, ""].join("\n");
  }
  const lines = [
    ...head,
    `${baseLine(c)} [Project page](${link})`,
    "",
    ...hasRegression(c) ? regressionNote(c) : [],
    table(["", "Before", "After", "\u0394"], [":---", "---:", "---:", "---:"], measureRows(c.before, c.after)),
    "",
    ...categoryDetails(c.categories),
    ...c.units ? unitDetails(c.units) : []
  ];
  if (c.base.kind !== "latest" && c.base.kind !== "none" && c.units === null) {
    lines.push("<sub>Function details need the latest report as base, the only one whose units are kept.</sub>", "");
  }
  let text = lines.join("\n");
  if (text.length > COMMENT_LIMIT) text = `${text.slice(0, COMMENT_LIMIT)}

\u2026cut to fit a comment.
`;
  return text;
}
function parseComparison(raw) {
  const r = raw ?? {};
  const str = (v, max = 200) => typeof v === "string" ? v.slice(0, max) : "";
  const num = (v) => Number(v) || 0;
  const kinds = ["base", "merge-base", "latest", "none"];
  const fn = (f) => ({
    unit: str(f?.unit),
    name: str(f?.name),
    before: num(f?.before),
    after: num(f?.after)
  });
  const list = (v, map) => Array.isArray(v) ? v.slice(0, LIST_LIMIT).map(map) : [];
  const measures = (v) => v && typeof v === "object" ? normalizeMeasures(v) : null;
  const version = str(r.version, 64);
  if (!version) throw new Error("the comparison names no version");
  const u = r.units;
  return {
    version,
    head_sha: str(r.head_sha, 64),
    base: {
      kind: kinds.includes(r.base?.kind) ? r.base.kind : "none",
      sha: str(r.base?.sha, 64) || null,
      requested_sha: str(r.base?.requested_sha, 64)
    },
    before: measures(r.before),
    after: measures(r.after) ?? normalizeMeasures({}),
    categories: (Array.isArray(r.categories) ? r.categories.slice(0, 200) : []).map((c) => ({
      id: str(c?.id),
      name: str(c?.name),
      before: measures(c?.before),
      after: measures(c?.after)
    })),
    units: u && typeof u === "object" ? {
      matched: list(u.matched, fn),
      regressed: list(u.regressed, fn),
      matched_count: num(u.matched_count),
      regressed_count: num(u.regressed_count),
      improved_count: num(u.improved_count),
      worsened_count: num(u.worsened_count),
      units_matched: list(u.units_matched, (x) => str(x)),
      units_regressed: list(u.units_regressed, (x) => str(x)),
      units_matched_count: num(u.units_matched_count),
      units_regressed_count: num(u.units_regressed_count)
    } : null
  };
}

// src/github.ts
var GitHubError = class extends Error {
  status;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
};
var GitHub = class {
  api;
  token;
  repository;
  constructor(token, repository, api = process.env.GITHUB_API_URL || "https://api.github.com") {
    this.api = api.replace(/\/$/, "");
    this.token = token;
    this.repository = repository;
  }
  async request(method, path, body) {
    const res = await fetch(`${this.api}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...body ? { "content-type": "application/json" } : {}
      },
      body: body ? JSON.stringify(body) : void 0
    });
    const text = await res.text();
    if (!res.ok) throw new GitHubError(res.status, `${method} ${path}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  /** The comment that carries the marker, if one was posted before */
  async findComment(issue, marker) {
    for (let page = 1; page <= 20; page++) {
      const list = await this.request(
        "GET",
        `/repos/${this.repository}/issues/${issue}/comments?per_page=100&page=${page}`
      );
      const found = list.find((c) => c.body?.includes(marker));
      if (found) return found;
      if (list.length < 100) break;
    }
    return null;
  }
  /**
   * Keeps one comment per marker: updates it in place, or creates it. With `create` false (nothing to report), a
   * pull request that never got a comment is left alone.
   */
  async upsertComment(issue, marker, body, create = true) {
    const old = await this.findComment(issue, marker);
    if (old) {
      if (old.body === body) return "unchanged";
      await this.request("PATCH", `/repos/${this.repository}/issues/comments/${old.id}`, { body });
      return "updated";
    }
    if (!create) return "skipped";
    await this.request("POST", `/repos/${this.repository}/issues/${issue}/comments`, { body });
    return "created";
  }
  /**
   * The open pull request a workflow_run followed. GitHub leaves `pull_requests` empty for forks, so those are found
   * by head branch and must still point at the commit that was measured.
   */
  async pullRequestOf(run) {
    if (run.pull_requests.length) return run.pull_requests[0].number;
    if (!run.head_repository || !run.head_branch) return null;
    const head = `${run.head_repository.owner.login}:${run.head_branch}`;
    const list = await this.request(
      "GET",
      `/repos/${this.repository}/pulls?state=open&per_page=100&head=${encodeURIComponent(head)}`
    );
    return list.find((pr) => pr.head.sha === run.head_sha)?.number ?? null;
  }
};

// src/pr.ts
async function getJson(url) {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return await res.json();
}
function siteOf(api) {
  const url = new URL(api);
  url.hostname = url.hostname.replace(/^api\./, "");
  return url.origin;
}
async function findBase(ctx, version, pr) {
  const data = `${ctx.api}/data/${ctx.repository}`;
  const v = `version=${encodeURIComponent(version)}`;
  const mergeBase = ctx.git("merge-base", pr.base.sha, pr.head.sha);
  const tries = [
    ["base", pr.base.sha],
    ["merge-base", mergeBase !== pr.base.sha ? mergeBase : null]
  ];
  for (const [kind, sha] of tries) {
    if (!sha) continue;
    const c = await getJson(`${data}/commit/${sha}.json?${v}`);
    if (c) return { kind, sha: c.commit.sha, measures: c.measures, categories: c.categories, latest: c.is_latest };
  }
  const o = await getJson(`${data}/overview.json?${v}`);
  if (o?.commit && o.measures) {
    return { kind: "latest", sha: o.commit.sha, measures: o.measures, categories: o.report_categories, latest: true };
  }
  return { kind: "none", sha: null, measures: null, categories: [], latest: false };
}
async function compareWithBase(ctx, version, pr, after) {
  const base = await findBase(ctx, version, pr);
  let units = null;
  if (base.latest) {
    const url = `${ctx.api}/data/${ctx.repository}/units.json?version=${encodeURIComponent(version)}`;
    const before = await getJson(url);
    if (before) units = compareUnits(before, after.units);
  }
  return {
    version,
    head_sha: pr.head.sha,
    base: { kind: base.kind, sha: base.sha, requested_sha: pr.base.sha },
    before: base.measures,
    after: after.measures,
    categories: base.measures ? compareCategories(base.categories, after.categories) : [],
    units
  };
}
async function setOutput(name, value) {
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `${name}=${value}
`);
}
async function readEvent() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) throw new Error("GITHUB_EVENT_PATH is not set");
  return JSON.parse(await readFile(path, "utf8"));
}
async function post(gh, issue, c, link) {
  try {
    const result = await gh.upsertComment(issue, markerOf(c.version), renderComment(c, link), hasChanges(c));
    console.log(`Progress comment on #${issue}: ${result}.`);
  } catch (err) {
    if (!(err instanceof GitHubError) || err.status !== 403 && err.status !== 404) throw err;
    console.log(
      `::warning::cannot comment on #${issue} (HTTP ${err.status}): add \`permissions: pull-requests: write\` to the job; the comparison is in the job summary`
    );
  }
}
async function runPullRequest(ctx, version, after) {
  const event = await readEvent();
  const pr = event.pull_request;
  const c = await compareWithBase(ctx, version, pr, after);
  const link = projectUrl(siteOf(ctx.api), ctx.repository, version);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${renderComment(c, link, false)}
`);
  const dir = join(process.env.RUNNER_TEMP || ".", "decmp-comment");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${version.replace(/[^\w.-]/g, "_")}.json`);
  await writeFile(file, JSON.stringify(c));
  await setOutput("comment-file", file);
  const regressed = hasRegression(c);
  await setOutput("regressed", String(regressed));
  const fork = pr.head.repo?.full_name !== pr.base.repo.full_name;
  if (fork) {
    console.log("::notice::a pull request from a fork gets a read-only token: upload the comment-file output as an artifact for the workflow_run that posts it (see decmp.dev/add)");
  } else if (ctx.token) {
    await post(new GitHub(ctx.token, ctx.repository), pr.number, c, link);
  }
  console.log(
    `Compared ${version} with ${c.base.kind === "none" ? "nothing (no report yet)" : `${c.base.kind} ${c.base.sha?.slice(0, 7)}`}: ${c.after.matched_code_percent.toFixed(2)}% code matched.`
  );
  if (regressed && ctx.failOnRegression) throw new Error(`this pull request regresses progress on ${version}`);
}
async function runWorkflowRun(ctx, dir) {
  const event = await readEvent();
  const run = event.workflow_run;
  if (run.event !== "pull_request") {
    console.log(`::notice::the run followed a ${run.event} event; no pull request to comment on`);
    return;
  }
  let files;
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }
  if (!files.length) {
    console.log(`::notice::no comparisons in ${dir}; nothing to post`);
    return;
  }
  if (!ctx.token) throw new Error('input "github-token" (GITHUB_TOKEN in a run step) is required to post the comments');
  const gh = new GitHub(ctx.token, ctx.repository);
  const issue = await gh.pullRequestOf(run);
  if (!issue) {
    console.log(`::notice::no open pull request has ${run.head_sha.slice(0, 7)} as head; nothing posted`);
    return;
  }
  const site = siteOf(ctx.api);
  for (const f of files.sort()) {
    const c = parseComparison(JSON.parse(await readFile(join(dir, f), "utf8")));
    if (c.head_sha && c.head_sha !== run.head_sha) {
      console.log(`::warning::${f} measured ${c.head_sha.slice(0, 7)}, not the run's ${run.head_sha.slice(0, 7)}; skipped`);
      continue;
    }
    await post(gh, issue, c, projectUrl(site, ctx.repository, c.version));
  }
}

// src/main.ts
var AUDIENCE = "https://decmp.dev";
var BANNER_TYPES = {
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".avif": "image/avif"
};
function git(...args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
async function oidcToken() {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) {
    throw new Error("no OIDC token available: add `permissions: id-token: write` to the job");
  }
  const res = await fetch(`${url}&audience=${encodeURIComponent(AUDIENCE)}`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`OIDC token request: HTTP ${res.status}`);
  return (await res.json()).value;
}
async function send(api, token, method, path, body, type = "application/json") {
  const res = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": type },
    body
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text}`);
  return JSON.parse(text);
}
async function readBanner() {
  const path = readInput("banner");
  if (!path) return null;
  const type = BANNER_TYPES[extname(path).toLowerCase()];
  if (!type) throw new Error(`banner must be one of ${Object.keys(BANNER_TYPES).join(", ")}`);
  const data = await readFile2(path);
  if (data.length > 1e6) throw new Error("banner must stay under 1 MB");
  return { type, data: new Uint8Array(data) };
}
async function readReport() {
  const report = JSON.parse(await readFile2(readInput("report", true), "utf8"));
  return summarizeReport(report);
}
async function main() {
  const api = readInput("api-url").replace(/\/$/, "") || "https://api.decmp.dev";
  const event = process.env.GITHUB_EVENT_NAME ?? "";
  const ctx = {
    api,
    token: readInput("github-token"),
    repository: process.env.GITHUB_REPOSITORY ?? "",
    failOnRegression: readInput("fail-on-regression") === "true",
    git
  };
  if (event === "workflow_run") return runWorkflowRun(ctx, readInput("comments") || "decmp-comment");
  if (event === "pull_request") return runPullRequest(ctx, readInput("version", true), await readReport());
  if (event.startsWith("pull_request")) {
    console.log(`::notice::decmp.dev ignores ${event} runs; use pull_request`);
    return;
  }
  const version = readInput("version", true);
  const { measures, categories, units } = await readReport();
  const banner = await readBanner();
  const sha = process.env.GITHUB_SHA ?? git("rev-parse", "HEAD");
  if (!sha) throw new Error("cannot tell which commit was measured");
  const payload = {
    version,
    commit: {
      sha,
      message: git("log", "-1", "--format=%B", sha),
      timestamp: git("log", "-1", "--format=%cI", sha) ?? (/* @__PURE__ */ new Date()).toISOString()
    },
    measures,
    categories,
    project: {
      name: readInput("name") || void 0,
      short_name: readInput("short-name") || void 0,
      platform: readInput("platform") || void 0,
      default_version: readInput("default-version") || void 0
    }
  };
  const token = await oidcToken();
  const result = await send(api, token, "POST", "/api/report", JSON.stringify(payload));
  const gzipped = new Uint8Array(gzipSync(JSON.stringify(units)));
  await send(api, token, "PUT", `/api/units?version=${encodeURIComponent(version)}`, gzipped, "application/gzip");
  if (banner) {
    const res = await send(api, token, "PUT", "/api/banner", banner.data, banner.type);
    console.log(res.changed ? "Uploaded the banner." : "Banner unchanged.");
  }
  console.log(
    `Uploaded ${version}: ${measures.matched_code_percent.toFixed(2)}% code matched, ${units.length} units. ${result.url ?? ""}`
  );
}
main().catch((err) => {
  console.log(`::error::${err.message}`);
  process.exitCode = 1;
});
