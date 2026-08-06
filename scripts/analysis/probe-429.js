require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) require("dns").setServers(String(process.env.DNS_SERVERS).split(","));
const path=require("path");
const {connectMongo,disconnectMongo}=require(path.join(__dirname,"../../packages/event-core/src"));
const {getSharedConfig}=require(path.join(__dirname,"../../packages/shared-config/src"));
const M=require(path.join(__dirname,"../../packages/shared-models/src"));
(async()=>{
  await connectMongo(getSharedConfig());
  const since=new Date(Date.now()-30*86400000);
  // Anywhere an error string was persisted, look for rate-limit language.
  const RE=/429|rate.?limit|too many requests|quota/i;
  const probes=[
    ["WorkflowRecord", M.WorkflowRecord, {createdAt:{$gte:since}}],
  ];
  for(const [label,Model,q] of probes){
    if(!Model) { console.log(`  ${label}: model not exported`); continue; }
    const rows=await Model.find(q).select("summary payload result stage subtype createdAt").limit(4000).lean();
    const hits=rows.filter(r=>RE.test(JSON.stringify(r)));
    console.log(`  ${label}: ${rows.length} records in 30d, ${hits.length} mention a rate limit`);
    for(const h of hits.slice(0,6)){
      console.log(`      ${new Date(h.createdAt).toISOString().slice(0,16)}  ${h.subtype||h.stage||""}  ${String(h.summary||"").slice(0,80)}`);
    }
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
