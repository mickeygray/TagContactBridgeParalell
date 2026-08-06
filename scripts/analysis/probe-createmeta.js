require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json","Content-Type":"application/json"};
(async()=>{
  // what the create screen shows, and whether fields carry descriptions/defaults
  const it=await(await fetch(`${BASE}/rest/api/3/issue/createmeta/ASSIGNMENT/issuetypes`,{headers:AUTH})).json();
  const task=(it.issueTypes||it.values||[]).find(x=>x.name==="Task");
  console.log(`  issue types on ASSIGNMENT: ${(it.issueTypes||it.values||[]).map(x=>x.name).join(", ")}`);
  if(!task){console.log("  no Task type found");return;}
  const fl=await(await fetch(`${BASE}/rest/api/3/issue/createmeta/ASSIGNMENT/issuetypes/${task.id}`,{headers:AUTH})).json();
  console.log(`\n  fields on the CREATE screen (${(fl.fields||fl.values||[]).length}):`);
  for(const f of (fl.fields||fl.values||[])){
    const bits=[f.required?"REQUIRED":"optional"];
    if(f.hasDefaultValue) bits.push("has default");
    console.log(`    ${String(f.fieldId||f.key).padEnd(22)}${String(f.name).padEnd(26)}${bits.join("  ")}`);
  }
  // is the project company-managed or team-managed? determines what admin can change
  const pr=await(await fetch(`${BASE}/rest/api/3/project/ASSIGNMENT`,{headers:AUTH})).json();
  console.log(`\n  project style: ${pr.style}   type: ${pr.projectTypeKey}   simplified: ${pr.simplified}`);
})().catch(e=>console.error("FAILED "+e.message));
