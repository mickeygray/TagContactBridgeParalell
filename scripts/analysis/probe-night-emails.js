require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) require("dns").setServers(String(process.env.DNS_SERVERS).split(","));
const path=require("path");
const {connectMongo,disconnectMongo}=require(path.join(__dirname,"../../packages/event-core/src"));
const {getSharedConfig}=require(path.join(__dirname,"../../packages/shared-config/src"));
const M=require(path.join(__dirname,"../../packages/shared-models/src"));
(async()=>{
  await connectMongo(getSharedConfig());
  const defs=await M.ReportDefinition.find({}).lean();
  console.log(`  ${defs.length} ReportDefinitions\n`);
  console.log(`  ${"name".padEnd(34)}${"enabled".padEnd(9)}${"cron/at".padEnd(18)}recipients`);
  for(const d of defs){
    const s=d.schedule||{};
    const to=[].concat(s.recipients||d.recipients||[]).length;
    console.log(`  ${String(d.name).slice(0,32).padEnd(34)}${String(s.enabled??d.enabled??"?").padEnd(9)}`
      +`${String(s.cron||s.at||s.time||"—").slice(0,16).padEnd(18)}${to} recipient(s)`);
  }
  const on=defs.filter(d=>(d.schedule?.enabled ?? d.enabled)===true);
  console.log(`\n  ENABLED: ${on.length}`);
  for(const d of on) console.log(`    "${d.name}"  blocks=${JSON.stringify(d.blocks||d.selection||d.preset||null)}`);
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
