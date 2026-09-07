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

/* Returns the public H2H league payload plus all match pages we can retrieve.
   The FPL endpoint is paginated, so the backend deliberately walks pages. */
app.get("/api/h2h/:id", async (req,res)=>{
  if(!validId(req.params.id)) return res.status(400).json({error:"Invalid H2H league ID"});
  try{
    let first=null, matches=[], page=1;
    for(; page<=20; page++){
      const d=await fplFetch(`/leagues-h2h-matches/league/${req.params.id}/?page=${page}`);
      if(!first) first=d;
      const ms=Array.isArray(d.matches)?d.matches:[];
      matches.push(...ms);
      if(ms.length===0 || ms.length<50) break;
    }
    const unique=new Map();
    for(const m of matches){
      const key=m.id ?? `${m.event}-${m.entry_1_entry}-${m.entry_2_entry}`;
      unique.set(String(key),m);
    }
    res.json({...first, matches:[...unique.values()], pagesFetched:page});
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
