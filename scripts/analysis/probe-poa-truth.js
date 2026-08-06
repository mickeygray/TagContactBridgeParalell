require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const {connectMongo,disconnectMongo}=require("./../../packages/event-core/src");
const {getSharedConfig}=require("./../../packages/shared-config/src");
const {createLogicsFacade}=require("./../../packages/shared-services/src/logicsFacadeService");
const {createLogicsClient}=require("./../../packages/shared-integrations/src");
const un=r=>{const d=r?.data??r;return Array.isArray(d)?d[0]:d;};
(async()=>{
  await connectMongo(getSharedConfig());
  const f=createLogicsFacade("TAG"), c=createLogicsClient("TAG");
  // The three "stale" TAG cases
  for(const id of [219780,403566,386122]){
    const b=un(await f.fetchCaseInfo(id));
    if(!b){console.log(`  ${id}: no case`);continue;}
    const poaish=Object.entries(b).filter(([k,v])=>/poa|attorney|2848|doc|status|service/i.test(k)&&v!=null&&v!=="");
    console.log(`  case ${id}  ${b.FirstName} ${b.LastName}`);
    console.log(`    ${poaish.map(([k,v])=>`${k}=${String(v).slice(0,30)}`).join("  ")||"(no poa/status-ish fields)"}`);
  }
  // Is there ANY route that lists documents on a case?
  console.log(`\n  probing document routes (GET only):`);
  for(const r of ["Documents/CaseDocument?CaseID=219780","Documents/CaseDocuments?CaseID=219780",
                  "Case/CaseDocuments?CaseID=219780","Documents/Documents?CaseID=219780"]){
    try{ const x=await c.request?.(r); console.log(`    ${r} -> ${JSON.stringify(x).slice(0,90)}`); }
    catch(e){ console.log(`    ${r} -> ${String(e.message).slice(0,80)}`); }
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
