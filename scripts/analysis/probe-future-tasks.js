require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const {connectMongo,disconnectMongo}=require("../../packages/event-core/src");
const {getSharedConfig}=require("../../packages/shared-config/src");
const {createLogicsClient}=require("../../packages/shared-integrations/src");
const un=r=>{const d=r?.data??r;return Array.isArray(d)?d:(Array.isArray(d?.Data)?d.Data:null);};
const day=ms=>new Date(ms).toISOString().slice(0,10);
const NOW=Date.parse("2026-08-05");
(async()=>{
  await connectMongo(getSharedConfig());
  for(const t of ["TAG","WYNN","AMITY"]){
    const c=createLogicsClient(t);
    let fut=[],past=0;
    // forward: today .. +8 months
    for(let w=0;w<4;w++){
      const start=NOW+w*60*86400000;
      let res;try{res=await c.getTasksByDateRange(day(start),day(start+60*86400000));}catch{continue;}
      for(const r of (un(res)||[])) if(!r.Deleted) fut.push(r);
    }
    console.log(`  ${t}: ${fut.length} live tasks due in the NEXT 8 months`);
    const st={},own={};
    for(const r of fut){ st[String(r.StatusID)]=(st[String(r.StatusID)]||0)+1;
      for(const u of (r.Users||[])) if(u.FullName) own[u.FullName]=(own[u.FullName]||0)+1; }
    console.log(`     StatusID: ${Object.entries(st).map(([a,b])=>`${a}=${b}`).join("  ")}`);
    console.log(`     top owners: ${Object.entries(own).sort((a,b)=>b[1]-a[1]).slice(0,5).map(([a,b])=>`${a}=${b}`).join("  ")}`);
    const THS=fut.filter(r=>/\bths\b/i.test(r.Subject||"")).length;
    const POA=fut.filter(r=>/\bpoa\b/i.test(r.Subject||"")).length;
    console.log(`     of those: ${THS} THS, ${POA} POA`);
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
