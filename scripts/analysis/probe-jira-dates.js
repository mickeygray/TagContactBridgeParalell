require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json","Content-Type":"application/json"};
(async()=>{
  // find the sprint field id
  const fields=await(await fetch(`${BASE}/rest/api/3/field`,{headers:AUTH})).json();
  const sprintField=(fields.find(f=>f.name==="Sprint")||{}).id;
  console.log("  sprint field: "+sprintField);

  const issues=[]; let token=null;
  do{
    const p=await(await fetch(`${BASE}/rest/api/3/search/jql`,{method:"POST",headers:AUTH,body:JSON.stringify({
      jql:"project in (ASSIGNMENT, POAREQ, RESO) AND statusCategory != Done",
      maxResults:100, fields:["duedate","created","updated","status","project",sprintField],
      ...(token?{nextPageToken:token}:{})})})).json();
    issues.push(...(p.issues||[])); token=p.nextPageToken||null;
  }while(token);

  let due=0, inSprint=0, sprintWithEnd=0, neither=0;
  const sprints=new Map();
  for(const i of issues){
    const f=i.fields;
    if(f.duedate) due++;
    const sp=f[sprintField]||[];
    if(sp.length){
      inSprint++;
      const last=sp[sp.length-1];
      if(last?.endDate){ sprintWithEnd++; }
      for(const s of sp) sprints.set(s.name,{state:s.state,end:s.endDate,start:s.startDate});
    }
    if(!f.duedate && !sp.length) neither++;
  }
  const pc=(a)=>`${a} (${(a/issues.length*100).toFixed(0)}%)`;
  console.log(`\n  open issues: ${issues.length}`);
  console.log(`  has duedate        : ${pc(due)}`);
  console.log(`  in a sprint        : ${pc(inSprint)}`);
  console.log(`  sprint has endDate : ${pc(sprintWithEnd)}`);
  console.log(`  NEITHER            : ${pc(neither)}   <- no real date exists at all`);
  console.log(`\n  sprints in play:`);
  for(const [n,s] of [...sprints].slice(0,12)) console.log(`    ${n.padEnd(22)} ${String(s.state).padEnd(8)} end=${(s.end||"(none)").slice(0,10)}`);
})().catch(e=>console.error("FAILED "+e.message));
