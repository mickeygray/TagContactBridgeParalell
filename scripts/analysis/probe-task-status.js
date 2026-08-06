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
  const c=createLogicsClient("TAG");
  const rows=[];
  for(let w=0;w<9;w++){
    const end=NOW-w*60*86400000;
    let res;try{res=await c.getTasksByDateRange(day(end-60*86400000),day(end));}catch{continue;}
    for(const r of (un(res)||[])) if(!r.Deleted) rows.push(r);
  }
  console.log(`  ${rows.length} live TAG tasks\n`);
  const byStatus={};
  for(const r of rows){
    const k=String(r.StatusID);
    const b=byStatus[k]||(byStatus[k]={n:0,pastDue:0,future:0,reminded:0,oldest:null,newest:null});
    b.n++;
    const due=Date.parse(r.DueDate||""); 
    if(Number.isFinite(due)){ if(due<NOW) b.pastDue++; else b.future++;
      if(!b.oldest||due<b.oldest)b.oldest=due; if(!b.newest||due>b.newest)b.newest=due; }
    if(r.LastReminded) b.reminded++;
  }
  for(const [k,b] of Object.entries(byStatus)){
    console.log(`  StatusID ${k}: ${b.n} tasks   pastDue ${b.pastDue}  future ${b.future}  everReminded ${b.reminded}`);
    console.log(`      due range ${b.oldest?day(b.oldest):"?"} .. ${b.newest?day(b.newest):"?"}`);
  }
  // sample subjects per status to infer meaning
  for(const k of Object.keys(byStatus)){
    const s=rows.filter(r=>String(r.StatusID)===k).slice(-6).map(r=>String(r.Subject||"").slice(0,40));
    console.log(`\n  StatusID ${k} sample subjects: ${s.join(" | ")}`);
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
