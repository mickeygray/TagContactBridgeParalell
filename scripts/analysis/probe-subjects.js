const {deriveSubject}=require("./taskSubject");
const R=require("./jira-roadblock-routing.json");
const M=require("./jira-migration-manifest.json");
const rows=[...R.buckets.isWork,...R.buckets.stale,...R.buckets.create,...R.buckets.covered,...R.buckets.notPoa];
const freq={},unresolved=[];
for(const r of rows){
  const d=deriveSubject(r.description,r.status);
  if(d.subject) freq[d.subject]=(freq[d.subject]||0)+1;
  else unresolved.push({k:r.jiraKey,w:d.waitingOn,d:(r.description||"").slice(0,60)});
}
const got=Object.values(freq).reduce((a,b)=>a+b,0);
console.log(`  ${rows.length} blocked issues -> ${got} got a real subject, ${unresolved.length} did not\n`);
console.log("  SUBJECTS PRODUCED:");
for(const [k,n] of Object.entries(freq).sort((a,b)=>b[1]-a[1]).slice(0,26))
  console.log(`    ${String(n).padStart(4)}  ${k}`);
const w={}; for(const u of unresolved) w[u.w]=(w[u.w]||0)+1;
console.log(`\n  NO SUBJECT: ${JSON.stringify(w)}`);
console.log("\n  sample of the business ones:");
for(const r of rows){
  const d=deriveSubject(r.description,r.status);
  if(d.business&&d.subject){ console.log(`    ${d.subject.padEnd(38)}"${r.description.slice(0,46)}"`); }
}
