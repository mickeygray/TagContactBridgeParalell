require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) require("dns").setServers(String(process.env.DNS_SERVERS).split(","));
const path=require("path");
const {connectMongo,disconnectMongo}=require(path.join(__dirname,"../../packages/event-core/src"));
const {getSharedConfig}=require(path.join(__dirname,"../../packages/shared-config/src"));
const M=require(path.join(__dirname,"../../packages/shared-models/src"));
const {CANONICAL_DEFINITION_NAME}=require(path.join(__dirname,"../../packages/shared-services/src/dailyReportFactService"));
const mask=e=>String(e||"").replace(/^(.{2})[^@]*/,"$1***");
(async()=>{
  await connectMongo(getSharedConfig());
  console.log("  CANONICAL_DEFINITION_NAME = "+JSON.stringify(CANONICAL_DEFINITION_NAME)+"\n");
  const defs=await M.ReportDefinition.find({}).lean();
  for(const d of defs.filter(x=>(x.schedule?.enabled ?? x.enabled)===true)){
    const s=d.schedule||{};
    console.log(`  "${d.name}"`);
    console.log(`      schedule: ${JSON.stringify(s).slice(0,220)}`);
    console.log(`      blocks:   ${JSON.stringify(d.blocks||d.selection||null)}   preset: ${d.preset||"—"}`);
    console.log(`      to:       ${[].concat(s.recipients||d.recipients||[]).map(mask).join(", ")}`);
    console.log(`      lastRun:  ${d.lastRunAt||d.lastRun||"—"}`);
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
