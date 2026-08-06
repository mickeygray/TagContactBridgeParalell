require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const {connectMongo,disconnectMongo}=require("../../packages/event-core/src");
const {getSharedConfig}=require("../../packages/shared-config/src");
const {createLogicsClient}=require("../../packages/shared-integrations/src");
const un=r=>{const d=r?.data??r;return Array.isArray(d)?d:(Array.isArray(d?.Data)?d.Data:null);};
const day=ms=>new Date(ms).toISOString().slice(0,10);
const NOW=Date.parse("2026-08-05");
const PREP=/tax prep|\bprep\b|\breturn/i, POA=/\bpoa\b/i, THS=/\bths\b/i;
(async()=>{
  await connectMongo(getSharedConfig());
  const c=createLogicsClient("TAG");
  const owners={prep:{},poa:{},ths:{}};
  let n=0;
  for(let w=0;w<9;w++){
    const end=NOW-w*60*86400000;
    let res;try{res=await c.getTasksByDateRange(day(end-60*86400000),day(end));}catch{continue;}
    const rows=un(res)||[];
    for(const r of rows){
      if(r.Deleted) continue; n++;
      const s=String(r.Subject||""); const who=(r.Users||[]).map(u=>u.FullName).filter(Boolean);
      const b=k=>{for(const u of who) owners[k][u]=(owners[k][u]||0)+1;};
      if(THS.test(s)) b("ths"); else if(POA.test(s)) b("poa"); else if(PREP.test(s)) b("prep");
    }
  }
  console.log(`  ${n} live TAG tasks scanned (18 months)\n`);
  for(const [k,label] of [["prep","TAX PREP / RETURN tasks"],["poa","POA tasks"],["ths","THS tasks"]]){
    const top=Object.entries(owners[k]).sort((a,b)=>b[1]-a[1]).slice(0,6);
    console.log(`  ${label}: ${top.map(([a,b])=>`${a}=${b}`).join("  ")||"(none)"}`);
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
