require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json","Content-Type":"application/json"};
const para=(text)=>({type:"paragraph",content:text?[{type:"text",text}]:[]});
(async()=>{
  const payload={fields:{
    summary:"[Database] | [CaseID] | [Name]",
    description:{type:"doc",version:1,content:[
      para("[Logics Subject]"),
      para("---"),
      para("[Logics Note Body]"),
    ]},
  }};
  const res=await fetch(`${BASE}/rest/api/3/issue/ASSIGNMENT-2049`,{method:"PUT",headers:AUTH,body:JSON.stringify(payload)});
  console.log(`  PUT ASSIGNMENT-2049 -> ${res.status===204?"updated":`HTTP ${res.status} ${(await res.text()).slice(0,200)}`}`);
  const t=n=>!n||typeof n!=="object"?"":n.type==="text"?(n.text||""):(n.content||[]).map(t).join("\n");
  const r=await(await fetch(`${BASE}/rest/api/3/issue/ASSIGNMENT-2049?fields=summary,description,status`,{headers:AUTH})).json();
  console.log(`\n  summary:     ${r.fields.summary}`);
  console.log(`  description:`);
  for(const line of t(r.fields.description).split("\n")) console.log(`    ${line}`);
  console.log(`  status: ${r.fields.status.name}`);
})().catch(e=>console.error("FAILED "+e.message));
