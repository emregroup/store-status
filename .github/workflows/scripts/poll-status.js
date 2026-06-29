// poll-status.js — checks Olo + DoorDash status feeds and logs changes.
// Runs on GitHub Actions (Node 20, built-in fetch). No npm install needed.
// Writes status-latest.json + history.json, and only signals a commit when
// something actually changed — so the repo isn't flooded with empty updates.

const fs = require("fs");

const FEEDS = {
  olo:      process.env.OLO_URL || "https://status.olo.com/api/v2/summary.json",
  doordash: process.env.DD_URL  || "https://doordash.statuspage.io/api/v2/summary.json",
};

const LATEST = "status-latest.json";
const HISTORY = "history.json";
const MAX_HISTORY = 2000;

const COMP = { operational:"ok", degraded_performance:"warn", partial_outage:"warn", major_outage:"down", under_maintenance:"maint" };
const IND  = { none:"ok", minor:"warn", major:"down", critical:"down", maintenance:"maint" };
const RANK = { ok:0, maint:1, warn:2, down:3, unknown:-1 };

async function fetchFeed(url){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, { signal:ctrl.signal, headers:{ "cache-control":"no-cache" } });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

function parse(data){
  let state = IND[data.status && data.status.indicator] || "unknown";
  const components = (data.components || []).filter(c => !c.group);
  for (const c of components){
    const cs = COMP[c.status] || "unknown";
    if (RANK[cs] > RANK[state]) state = cs;
  }
  const incidents = (data.incidents || [])
    .filter(i => i.status !== "resolved" && i.status !== "completed")
    .map(i => ({
      id: i.id,
      name: i.name,
      impact: i.impact,
      status: i.status,
      updated_at: i.updated_at || i.created_at,
      note: ((i.incident_updates && i.incident_updates[0] && i.incident_updates[0].body) || "")
              .replace(/\s+/g, " ").slice(0, 500),
    }));
  return { state, description: (data.status && data.status.description) || "", incidents };
}

function load(path, fallback){
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch (e){ return fallback; }
}

function fingerprint(services){
  const o = {};
  for (const k of Object.keys(services)){
    o[k] = { state: services[k].state, inc: (services[k].incidents || []).map(i => i.id).sort() };
  }
  return JSON.stringify(o);
}

(async () => {
  const prev = load(LATEST, { services:{} });
  const history = load(HISTORY, []);
  const now = new Date().toISOString();

  const services = {};
  for (const [key, url] of Object.entries(FEEDS)){
    try {
      services[key] = Object.assign({ checked: now }, parse(await fetchFeed(url)));
    } catch (e){
      services[key] = { state:"unknown", description:"feed unreachable: " + e.message, incidents:[], checked:now };
    }
  }

  // record a history row whenever a service's state differs from last run
  let changed = false;
  for (const key of Object.keys(services)){
    const prevState = prev.services && prev.services[key] ? prev.services[key].state : null;
    const next = services[key].state;
    if (prevState !== next){
      changed = true;
      history.unshift({
        t: now,
        service: key,
        from: prevState,            // null on the very first run
        to: next,
        description: services[key].description,
        incidents: services[key].incidents.map(i => ({ name:i.name, impact:i.impact, status:i.status, note:i.note })),
      });
    }
  }

  // also commit if incident text changed even when the headline state didn't
  const fp = fingerprint(services);
  if (!prev.fingerprint) changed = true;
  else if (prev.fingerprint !== fp) changed = true;

  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;

  if (changed){
    fs.writeFileSync(LATEST, JSON.stringify({ generated:now, fingerprint:fp, services }, null, 2));
    fs.writeFileSync(HISTORY, JSON.stringify(history, null, 2));
    const summary = Object.entries(services).map(([k,v]) => k + ":" + v.state).join(" ");
    fs.writeFileSync(".status-commitmsg", "status " + summary + " @ " + now);
    console.log("CHANGED:", summary);
  } else {
    console.log("no change");
  }
})().catch(e => { console.error(e); process.exit(1); });
