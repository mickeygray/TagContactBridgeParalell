require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json","Content-Type":"application/json"};
const t=n=>!n||typeof n!=="object"?"":n.type==="text"?(n.text||""):(n.content||[]).map(t).join(" ");
(async()=>{
  const r=await(await fetch(`${BASE}/rest/api/3/search/jql`,{method:"POST",headers:AUTH,body:JSON.stringify({
    jql:'key = ASSIGNMENT-2040',
    fields:["summary","status","assignee","reporter","duedate","description","project","created","updated","priority","customfield_10020","customfield_10032"]})})).json();
  const i=r.issues[0];
  const f=i.fields;
  const shape={
    key:i.key,
    fields:{
      summary:f.summary,
      status:{name:f.status.name,statusCategory:{key:f.status.statusCategory.key,name:f.status.statusCategory.name}},
      project:{key:f.project.key,name:f.project.name},
      assignee:f.assignee?{accountId:f.assignee.accountId,displayName:f.assignee.displayName,active:f.assignee.active,emailAddress:f.assignee.emailAddress??"(absent — Atlassian privacy)"}:null,
      reporter:f.reporter?{accountId:f.reporter.accountId,displayName:f.reporter.displayName}:null,
      duedate:f.duedate,
      created:f.created,
      updated:f.updated,
      priority:f.priority?{name:f.priority.name}:null,
      description:"<Atlassian document format>  -> flattens to: "+JSON.stringify(t(f.description).trim()),
      customfield_10020:(f.customfield_10020||[]).map(s=>({id:s.id,name:s.name,state:s.state,startDate:s.startDate,endDate:s.endDate})),
      customfield_10032:f.customfield_10032,
    },
  };
  console.log(JSON.stringify(shape,null,2));
})().catch(e=>console.error("FAILED "+e.message));
