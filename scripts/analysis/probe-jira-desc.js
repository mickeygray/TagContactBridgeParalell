require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json","Content-Type":"application/json"};
const t=n=>!n||typeof n!=="object"?"":n.type==="text"?(n.text||""):(n.content||[]).map(t).join(" ");
(async()=>{
  const r=await(await fetch(`${BASE}/rest/api/3/search/jql`,{method:"POST",headers:AUTH,body:JSON.stringify({
    jql:"project in (ASSIGNMENT, POAREQ) AND statusCategory != Done ORDER BY updated DESC",
    maxResults:100, fields:["summary","status","description","project"]})})).json();
  const by={};
  for(const i of r.issues||[]){
    const s=i.fields.status?.name||"?"; const d=t(i.fields.description).trim().replace(/\s+/g," ");
    (by[s]||(by[s]=[])).push(d);
  }
  for(const [s,ds] of Object.entries(by)){
    const filled=ds.filter(Boolean);
    console.log(`\n  ${s}  (${filled.length}/${ds.length} have a description)`);
    for(const d of filled.slice(0,5)) console.log(`      "${d.slice(0,88)}"`);
  }
})().catch(e=>console.error("FAILED "+e.message));
