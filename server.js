const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const FPL = "https://fantasy.premierleague.com/api";
// In-memory cache: resets on every restart/deploy and is per-instance (not
// shared if this ever scales beyond one dyno). Fine on Render's free tier —
// just don't be surprised if numbers look briefly stale right after a
// redeploy, or diverge across instances if you scale up. Swap for Redis if
// that ever matters.
const CACHE = new Map();
const FETCH_TIMEOUT_MS = 8000; // upstream FPL calls must not hang our routes forever

app.set("trust proxy", 1); // Render sits behind a proxy; needed for req.ip to reflect the real client

// Cheap, dependency-free security headers. Same-origin app, so this is
// mostly hygiene rather than defense against a real cross-site threat.
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});

/* Minimal in-memory sliding-window rate limiter, scoped to /api/*.
   No extra dependency (express-rate-limit) so it works with zero npm
   install changes; swap in that package instead if this ever needs to
   survive multiple dynos/instances, since this state is per-process. */
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60; // requests per IP per window
const rateBuckets = new Map();
setInterval(() => {
  const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
  for (const [ip, hits] of rateBuckets) {
    const kept = hits.filter(t => t > cutoff);
    if (kept.length) rateBuckets.set(ip, kept); else rateBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function rateLimit(req, res, next) {
  const ip = req.ip || "unknown";
  const now = Date.now();
  const cutoff = now - RATE_LIMIT_WINDOW_MS;
  const hits = (rateBuckets.get(ip) || []).filter(t => t > cutoff);
  hits.push(now);
  rateBuckets.set(ip, hits);
  if (hits.length > RATE_LIMIT_MAX) {
    res.setHeader("Retry-After", Math.ceil(RATE_LIMIT_WINDOW_MS / 1000));
    return res.status(429).json({ error: "Too many requests — please slow down and try again shortly." });
  }
  next();
}

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname, "public")));
app.use("/api", rateLimit);

function cacheKey(url){ return url; }
function ttlFor(url){
  if(url.includes("bootstrap-static")) return 60*60*1000;
  if(url.includes("/event/") && url.includes("/live/")) return 2*60*1000;
  if(url.includes("/history/")) return 5*60*1000;
  if(url.includes("leagues-h2h-matches")) return 5*60*1000;
  if(url.includes("/fixtures")) return 15*60*1000;
  return 5*60*1000;
}
async function fplFetch(pathname){
  const url = pathname.startsWith("http") ? pathname : FPL + pathname;
  const key=cacheKey(url), now=Date.now(), hit=CACHE.get(key);
  if(hit && now-hit.time < ttlFor(url)) return hit.data;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let r;
  try{
    r = await fetch(url,{
      signal: controller.signal,
      headers:{
        "User-Agent":"Supreme-FPL-Hub/1.0",
        "Accept":"application/json"
      }
    });
  }catch(e){
    if(e.name === "AbortError") throw new Error("FPL API timed out — try again in a moment.");
    throw e;
  }finally{
    clearTimeout(timer);
  }
  if(!r.ok) throw new Error(`FPL API returned HTTP ${r.status}`);
  const data=await r.json();
  CACHE.set(key,{time:now,data});
  return data;
}
function validId(x){ return /^\d+$/.test(String(x||"")); }

app.get("/api/health",(req,res)=>res.json({
  ok:true, service:"Supreme FPL Hub API", time:new Date().toISOString(),
  cacheEntries:CACHE.size
}));

app.get("/api/bootstrap", async (req,res)=>{
  try{ res.json(await fplFetch("/bootstrap-static/")); }
  catch(e){res.status(502).json({error:e.message});}
});
app.get("/api/fixtures", async (req,res)=>{
  try{ res.json(await fplFetch("/fixtures/")); }
  catch(e){res.status(502).json({error:e.message});}
});
app.get("/api/live/:gw", async (req,res)=>{
  if(!validId(req.params.gw)) return res.status(400).json({error:"Invalid gameweek"});
  try{ res.json(await fplFetch(`/event/${req.params.gw}/live/`)); }
  catch(e){res.status(502).json({error:e.message});}
});
app.get("/api/entry/:id/history", async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid entry ID"});
  try{ res.json(await fplFetch(`/entry/${req.params.id}/history/`)); }
  catch(e){res.status(502).json({error:e.message});}
});
app.get("/api/entry/:id", async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid entry ID"});
  try{ res.json(await fplFetch(`/entry/${req.params.id}/`)); }
  catch(e){res.status(502).json({error:e.message});}
});
app.get("/api/entry/:id/picks/:gw", async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid entry ID"});
  if(!validId(req.params.gw)) return res.status(400).json({error:"Invalid gameweek"});
  try{ res.json(await fplFetch(`/entry/${req.params.id}/event/${req.params.gw}/picks/`)); }
  catch(e){res.status(502).json({error:e.message});}
});

/* Returns the H2H league standings plus all match pages we can retrieve.
   FPL exposes standings and matches as two separate paginated endpoints,
   so the backend fetches both and combines them. */
app.get("/api/h2h/:id", async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid H2H league ID"});
  try{
    let leagueInfo=null, standingsResults=[], sPage=1;
    for(; sPage<=20; sPage++){
      const d=await fplFetch(`/leagues-h2h/${req.params.id}/standings/?page_standings=${sPage}`);
      if(!leagueInfo) leagueInfo=d.league;
      const rs=Array.isArray(d?.standings?.results)?d.standings.results:[];
      standingsResults.push(...rs);
      if(!d?.standings?.has_next) break;
    }
    if(!standingsResults.length) throw Error("No teams returned. Check the H2H league ID.");

    let matches=[], mPage=1;
    for(; mPage<=20; mPage++){
      const d=await fplFetch(`/leagues-h2h-matches/league/${req.params.id}/?page=${mPage}`);
      const ms=Array.isArray(d.results)?d.results:[];
      matches.push(...ms);
      if(!d.has_next) break;
    }
    const unique=new Map();
    for(const m of matches){
      const key=m.id ?? `${m.event}-${m.entry_1_entry}-${m.entry_2_entry}`;
      unique.set(String(key),m);
    }
    res.json({league:leagueInfo, standings:{results:standingsResults}, matches:[...unique.values()], pagesFetched:mPage});
  }catch(e){res.status(502).json({error:e.message});}
});

/* Small server-side helper for manager history. This keeps the browser from
   making dozens of direct FPL requests. It is also used by the cup engine. */
app.post("/api/histories", async (req,res)=>{
  const ids=Array.isArray(req.body?.entryIds)?req.body.entryIds:[];
  const clean=[...new Set(ids.map(String).filter(validId))].slice(0,100);
  if(!clean.length) return res.status(400).json({error:"No entry IDs supplied"});
  try{
    const out={};
    for(const id of clean) out[id]=await fplFetch(`/entry/${id}/history/`);
    res.json(out);
  }catch(e){res.status(502).json({error:e.message});}
});

app.get(/.*/,(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));
app.listen(PORT,()=>console.log(`Supreme FPL Hub running on port ${PORT}`));
