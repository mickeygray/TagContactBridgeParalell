require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json","Content-Type":"application/json"};
const t=n=>!n||typeof n!=="object"?"":n.type==="text"?(n.text||""):(n.content||[]).map(t).join(" ");
async function all(jql,fields){const o=[];let k=null;do{
  const p=await(await fetch(`${BASE}/rest/api/3/search/jql`,{method:"POST",headers:AUTH,
    body:JSON.stringify({jql,maxResults:100,fields,...(k?{nextPageToken:k}:{})})})).json();
  o.push(...(p.issues||[]));k=p.nextPageToken||null;}while(k);return o;}
(async()=>{
  // 1. What are POAREQ's Done statuses actually CALLED?
  const poa=await all('project = POAREQ AND statusCategory = Done',["status","resolution","summary","description"]);
  const st={},res={};
  for(const i of poa){ st[i.fields.status.name]=(st[i.fields.status.name]||0)+1;
    res[i.fields.resolution?.name||"(no resolution set)"]=(res[i.fields.resolution?.name||"(no resolution set)"]||0)+1; }
  console.log(`  POAREQ Done-category issues: ${poa.length}`);
  console.log(`  status NAMES in the Done category:`);
  for(const [k,n] of Object.entries(st).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(n).padStart(5)}  ${k}`);
  console.log(`  resolution values:`);
  for(const [k,n] of Object.entries(res).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(n).padStart(5)}  ${k}`);

  // 2. Do the linked pairs even refer to the same CLIENT?
  const R=require("./jira-roadblock-routing.json");
  const pairs=R.buckets.stale.slice(0,10);
  const keys=[...new Set(pairs.flatMap(p=>[p.jiraKey,...(p.siblings||[]).map(s=>s.key)]))];
  const rows=await all(`key in (${keys.join(",")})`,["summary","status","project","resolution"]);
  const byKey=new Map(rows.map(r=>[r.key,r.fields]));
  const norm=s=>String(s||"").toLowerCase().replace(/[^a-z\s]/g," ").split(/\s+/).filter(w=>w.length>=3);
  console.log(`\n  NAME AGREEMENT between each roadblock and its "done" POAREQ sibling:\n`);
  for(const p of pairs){
    const a=byKey.get(p.jiraKey); if(!a) continue;
    for(const s of (p.siblings||[])){
      const b=byKey.get(s.key); if(!b) continue;
      const A=norm(a.summary),B=norm(b.summary);
      const shared=A.filter(w=>B.includes(w));
      console.log(`    ${p.jiraKey} "${a.summary.slice(0,30)}"`);
      console.log(`      ${s.key} "${b.summary.slice(0,30)}"  status="${b.status.name}" res="${b.resolution?.name||"none"}"`);
      console.log(`      shared name words: ${shared.length?shared.join(","):"*** NONE — DIFFERENT CLIENTS ***"}`);
    }
  }
})().catch(e=>console.error("FAILED "+e.message));
