require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const fs=require("fs");
const {connectMongo,disconnectMongo}=require("../../packages/event-core/src");
const {getSharedConfig}=require("../../packages/shared-config/src");
const {createLogicsClient}=require("../../packages/shared-integrations/src");
const un=r=>{const d=r?.data??r;return Array.isArray(d)?d:(Array.isArray(d?.Data)?d.Data:null);};
const day=ms=>new Date(ms).toISOString().slice(0,10);
const NOW=Date.parse("2026-08-05");
(async()=>{
  await connectMongo(getSharedConfig());
  const l=JSON.parse(fs.readFileSync("scripts/analysis/migration-ledger.json","utf8"));
  const want=new Map(Object.entries(l).map(([k,v])=>[v.taskId,{jiraKey:k,...v}]));
  let found=0,checked=0;
  for(const t of ["TAG","AMITY","WYNN"]){
    const c=createLogicsClient(t);
    const seen=new Map();
    for(let w=-3;w<3;w++){
      const end=NOW-w*60*86400000;
      let res;try{res=await c.getTasksByDateRange(day(end-60*86400000),day(end));}catch{continue;}
      for(const r of (un(res)||[])) seen.set(r.TaskID,r);
    }
    const mine=[...want.values()].filter(x=>x.tenant===t);
    const hits=mine.filter(x=>seen.has(x.taskId));
    found+=hits.length; checked+=mine.length;
    console.log(`  ${t}: ${hits.length}/${mine.length} of the created tasks read back`);
    for(const x of hits.slice(0,2)){
      const r=seen.get(x.taskId);
      console.log(`      TaskID ${r.TaskID}  case ${r.CaseID}  "${String(r.Subject).slice(0,44)}"`);
      console.log(`          users: ${(r.Users||[]).map(u=>u.FullName).join(", ")}   due ${String(r.DueDate).slice(0,10)}   deleted=${r.Deleted}`);
      console.log(`          body : "${String(r.Comments||"").slice(0,60)}"`);
    }
  }
  console.log(`\n  read back ${found}/${checked}`);
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
