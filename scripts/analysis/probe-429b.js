require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) require("dns").setServers(String(process.env.DNS_SERVERS).split(","));
const path=require("path");
const {connectMongo,disconnectMongo}=require(path.join(__dirname,"../../packages/event-core/src"));
const {getSharedConfig}=require(path.join(__dirname,"../../packages/shared-config/src"));
const M=require(path.join(__dirname,"../../packages/shared-models/src"));
// Only ERROR-shaped text, and only real rate-limit language.
const RE=/\b429\b|too many requests|rate limit (exceeded|hit|reached)|quota exceeded/i;
(async()=>{
  await connectMongo(getSharedConfig());
  const since=new Date(Date.now()-30*86400000);
  const rows=await M.WorkflowRecord.find({createdAt:{$gte:since}})
    .select("summary payload result stage subtype createdAt").limit(8000).lean();
  const hits=[];
  for(const r of rows){
    // Look ONLY at error-ish fields, not the whole document.
    const text=[r.summary,r.payload?.error,r.result?.error,r.payload?.reason,r.result?.reason,
      ...(Array.isArray(r.result?.errors)?r.result.errors:[])].filter(Boolean).join(" | ");
    if(RE.test(text)) hits.push({at:r.createdAt,what:r.subtype||r.stage,text:text.slice(0,110)});
  }
  console.log(`  scanned ${rows.length} records over 30 days`);
  console.log(`  genuine rate-limit errors: ${hits.length}\n`);
  const byHour={};
  for(const h of hits){ const k=new Date(h.at).getHours(); byHour[k]=(byHour[k]||0)+1; }
  for(const h of hits.slice(0,10)) console.log(`    ${new Date(h.at).toISOString().slice(0,16)}  ${h.what}  ${h.text}`);
  if(hits.length) console.log(`\n  by hour of day: ${JSON.stringify(byHour)}`);
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
