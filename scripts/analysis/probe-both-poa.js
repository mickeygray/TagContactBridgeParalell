require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const fs=require("fs");
const {connectMongo,disconnectMongo}=require("../../packages/event-core/src");
const {getSharedConfig}=require("../../packages/shared-config/src");
const {createLogicsClient}=require("../../packages/shared-integrations/src");
const un=r=>{const d=r?.data??r;return Array.isArray(d)?d:(Array.isArray(d?.Data)?d.Data:null);};
const POA_FILED=/\bfiled\b[^.]{0,20}\bpoa\b|\bpoa\b[^.]{0,20}\bfiled\b/i;
const NOT=/new task assigned|task updated|failed|rejected|unable|can'?t|mismatch|waiting/i;
const STATE=/state poa|poa.*\bstate\b/i;
(async()=>{
  await connectMongo(getSharedConfig());
  const items=JSON.parse(fs.readFileSync("scripts/analysis/missing-years-poa-check.json","utf8")).items;
  const targets=items.filter(i=>i.poaFiled&&STATE.test(i.poaFiled));
  const c=createLogicsClient("TAG");
  let both=0,stateOnly=0;
  for(const t of targets){
    let list; try{list=un(await c.getActivities(t.caseId));}catch{list=null;}
    if(!list){console.log(`  ${t.jiraKey}  UNKNOWN — read failed`);continue;}
    const poas=list.map(r=>String(r.ActivitySubject||r.Subject||""))
      .filter(s=>POA_FILED.test(s)&&!NOT.test(s));
    const irs=poas.filter(s=>!STATE.test(s));
    if(irs.length){both++;console.log(`  ${t.jiraKey.padEnd(16)}case ${String(t.caseId).padEnd(8)}HAS IRS POA TOO -> "${irs[0].trim().slice(0,40)}"`);}
    else{stateOnly++;console.log(`  ${t.jiraKey.padEnd(16)}case ${String(t.caseId).padEnd(8)}STATE ONLY (${poas.length} poa acts) -> still blocked for IRS`);}
  }
  console.log(`\n  of ${targets.length} state-POA cases: ${both} also have an IRS POA, ${stateOnly} are state-only`);
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
