const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const FPL = "https://fantasy.premierleague.com/api";
const CACHE = new Map();

app.use(express.json({limit:"1mb"}));
app.use(express.static(path.join(__dirname, "public")));

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
  const r=await fetch(url,{headers:{
    "User-Agent":"Supreme-FPL-Hub/1.0",
    "Accept":"application/json"
  }});
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
