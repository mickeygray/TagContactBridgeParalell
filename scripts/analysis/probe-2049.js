require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json"};
const t=n=>!n||typeof n!=="object"?"":n.type==="text"?(n.text||""):(n.content||[]).map(t).join(" ");
(async()=>{
  const r=await(await fetch(`${BASE}/rest/api/3/issue/ASSIGNMENT-2049?fields=summary,status,project,issuetype,assignee,created`,{headers:AUTH})).json();
  const f=r.fields;
  console.log(`  ${r.key}`);
  console.log(`    project   ${f.project.key}  "${f.project.name}"`);
  console.log(`    status    ${f.status.name}  (category: ${f.status.statusCategory.name})`);
  console.log(`    type      ${f.issuetype.name}`);
  console.log(`    assignee  ${f.assignee?f.assignee.displayName:"(unassigned)"}`);
  console.log(`    created   ${f.created}`);
  console.log(`    summary   ${f.summary}`);
  const d=await(await fetch(`${BASE}/rest/api/3/issue/ASSIGNMENT-2049?fields=description`,{headers:AUTH})).json();
  const words=t(d.fields.description).trim().split(/\s+/).length;
  console.log(`    description: ${words} words`);
})().catch(e=>console.error("FAILED "+e.message));
