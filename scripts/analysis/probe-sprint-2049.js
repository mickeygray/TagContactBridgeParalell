require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json","Content-Type":"application/json"};
(async()=>{
  for(const k of ["ASSIGNMENT-2049","ASSIGNMENT-2040"]){
    const r=await(await fetch(`${BASE}/rest/api/3/issue/${k}?fields=summary,status,customfield_10020`,{headers:AUTH})).json();
    const sp=r.fields.customfield_10020||[];
    console.log(`  ${k}  status ${r.fields.status.name.padEnd(16)} sprints: ${sp.length?sp.map(s=>`${s.name}(${s.state})`).join(", "):"(NONE — sits in the backlog)"}`);
  }
  // find the active sprint on the board
  const bs=await(await fetch(`${BASE}/rest/agile/1.0/board?projectKeyOrId=ASSIGNMENT`,{headers:AUTH})).json();
  console.log(`\n  boards: ${(bs.values||[]).map(b=>`${b.id} "${b.name}" (${b.type})`).join(", ")}`);
  for(const b of (bs.values||[])){
    const sp=await(await fetch(`${BASE}/rest/agile/1.0/board/${b.id}/sprint?state=active`,{headers:AUTH})).json();
    console.log(`    board ${b.id} active sprint: ${(sp.values||[]).map(s=>`${s.id} "${s.name}"`).join(", ")||"(none)"}`);
  }
})().catch(e=>console.error("FAILED "+e.message));
