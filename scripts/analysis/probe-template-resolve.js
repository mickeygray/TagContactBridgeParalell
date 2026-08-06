require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const {connectMongo,disconnectMongo}=require("../../packages/event-core/src");
const {getSharedConfig}=require("../../packages/shared-config/src");
const {createLogicsFacade}=require("../../packages/shared-services/src/logicsFacadeService");
const un=r=>{const d=r?.data??r;return Array.isArray(d)?d[0]:d;};
const CASE=/\b(\d{5,7})\b/, TEN=/\b(TAG|WYNN|AMITY)\b/i;
const NOISE=/\b(TAG|WYNN|AMITY|TEST|PROBE|IRS|STATE|POA|RE|FOR|THE|AND|MO|SENT|HOLD|READY|FILE)\b/gi;
function parse(s){return{caseId:s.match(CASE)?Number(s.match(CASE)[1]):null,
  statedTenant:s.match(TEN)?s.match(TEN)[1].toUpperCase():null,
  words:s.replace(CASE," ").replace(NOISE," ").replace(/[^A-Za-z\s'-]/g," ").split(/\s+/).map(w=>w.trim().toLowerCase()).filter(w=>w.length>=3)};}
(async()=>{
  await connectMongo(getSharedConfig());
  const cases=[
    "TEMPLATE | HOW TO FILL THIS OUT | TAG | 401656 | Prep Return",
    "TAG | 401656 | Prep Return",
    "TAG | 401656 | MICHAEL NIELSON | Prep Return",
  ];
  for(const s of cases){
    const p=parse(s);
    const f=createLogicsFacade(p.statedTenant||"TAG");
    const b=un(await f.fetchCaseInfo(p.caseId));
    const nm=b?`${b.FirstName||""} ${b.MiddleName||""} ${b.LastName||""}`.toLowerCase():"";
    const nameMatch=p.words.some(w=>nm.includes(w));
    console.log(`  "${s}"`);
    console.log(`     case ${p.caseId}  tenant stated: ${p.statedTenant}  logics name: "${nm.replace(/\s+/g," ").trim()}"`);
    console.log(`     name words: [${p.words.join(", ")}]`);
    console.log(`     name-match resolution: ${nameMatch?"RESOLVES":"FAILS — falls through to other tenants"}`);
  }
  await disconnectMongo();
})().catch(e=>console.error("FAILED "+e.message));
