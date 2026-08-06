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
  const ledger=JSON.parse(fs.readFileSync("scripts/analysis/migration-ledger.json","utf8"));
  const ready=JSON.parse(fs.readFileSync("scripts/analysis/MIGRATION-READY.json","utf8")).items;
  const src=new Map(ready.map(i=>[i.jiraKey,i]));
  // pick tasks that were assigned to the DEFAULT PAIR (2 users sent)
  const pair=Object.entries(ledger).filter(([k])=>{const s=src.get(k);return s&&s.users.length===2;});
  const solo=Object.entries(ledger).filter(([k])=>{const s=src.get(k);return s&&s.users.length===1;});
  console.log(`  sent with 2 users: ${pair.length}   with 1 user: ${solo.length}\n`);
  const c=createLogicsClient("TAG");
  const seen=new Map();
  for(let w=-2;w<2;w++){
    const end=NOW-w*60*86400000;
    let res;try{res=await c.getTasksByDateRange(day(end-60*86400000),day(end));}catch{continue;}
    for(const r of (un(res)||[])) seen.set(r.TaskID,r);
  }
  let both=0,one=0;
  for(const [k,v] of pair){
    if(v.tenant!=="TAG") continue;
    const r=seen.get(v.taskId); if(!r) continue;
    const n=(r.Users||[]).length;
    if(n>=2) both++; else one++;
    if(both+one<=3) console.log(`    ${k.padEnd(15)}TaskID ${v.taskId}  users attached: ${(r.Users||[]).map(u=>u.FullName).join(", ")||"(none)"}`);
  }
  console.log(`\n  of the pair-assigned TAG tasks read back: ${both} kept both users, ${one} kept one`);
  // body integrity
  const sample=pair.find(([k,v])=>v.tenant==="TAG"&&seen.has(v.taskId));
  if(sample){
    const r=seen.get(sample[1].taskId); const s=src.get(sample[0]);
    console.log(`\n  BODY CHECK  ${sample[0]}`);
    console.log(`    sent : "${s.body}"`);
    console.log(`    got  : "${String(r.Comments||"").replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim().slice(0,140)}"`);
    console.log(`    note preserved: ${String(r.Comments||"").includes(s.body.slice(0,20))}`);
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
