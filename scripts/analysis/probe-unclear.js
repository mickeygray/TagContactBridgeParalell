const r=require("./jira-roadblock-routing.json");
const all=[...r.buckets.notPoa,...r.buckets.covered,...r.buckets.stale,...r.buckets.create];
const unclear=all.filter(x=>x.waitingOn==="UNCLEAR");
console.log(`  ${unclear.length} UNCLEAR — what they actually say:\n`);
const freq={};
for(const u of unclear){
  const d=(u.description||"").trim();
  const k=d?d.slice(0,46):"(EMPTY DESCRIPTION)";
  freq[k]=(freq[k]||0)+1;
}
for(const [k,n] of Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,28))
  console.log(`    ${String(n).padStart(3)}  "${k}"`);
