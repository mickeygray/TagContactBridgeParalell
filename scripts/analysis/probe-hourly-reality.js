require("dotenv").config({ quiet: true });
if (process.env.DNS_SERVERS) require("dns").setServers(String(process.env.DNS_SERVERS).split(","));
const path=require("path");
const {connectMongo,disconnectMongo}=require(path.join(__dirname,"../../packages/event-core/src"));
const {getSharedConfig}=require(path.join(__dirname,"../../packages/shared-config/src"));
const {WorkflowRecord}=require(path.join(__dirname,"../../packages/shared-models/src"));
const ago=d=>d?Math.round((Date.now()-new Date(d).getTime())/86400000)+"d ago":"never";
(async()=>{
  await connectMongo(getSharedConfig());
  const probes=[
    ["NCOA mailbox run",{family:"lexis",subtype:"ncoa-mailbox-run"}],
    ["NCOA attachment",{family:"lexis",subtype:"ncoa-mailbox-attachment"}],
    ["mailbox-ingest (shared loop)",{workflow:"mailbox-ingest"}],
  ];
  for(const [label,q] of probes){
    const n=await WorkflowRecord.countDocuments(q);
    const last=await WorkflowRecord.findOne(q).sort({createdAt:-1}).lean();
    console.log(`  ${label.padEnd(30)} ${String(n).padStart(6)} records   newest ${ago(last?.createdAt)}  ${last?.createdAt?new Date(last.createdAt).toISOString().slice(0,16):""}`);
    if(last?.stage) console.log(`  ${"".padEnd(30)} stage=${last.stage}`);
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
