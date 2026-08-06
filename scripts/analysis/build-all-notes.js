const fs=require("fs");
const M=require("./jira-migration-manifest.json");
const R=require("./jira-roadblock-routing.json");
const desc=new Map();
for(const b of Object.values(R.buckets)) for(const r of b) if(r.jiraKey) desc.set(r.jiraKey,r.description||"");
const rows=M.items.map(i=>{
  const d=(desc.get(i.jiraKey) ?? String(i.proposed.Comments||"").split("\n")[0]).trim();
  return { jiraKey:i.jiraKey, status:i.status, note:(d.startsWith("(no detail")?"":d) };
});
const B=60, batches=[];
for(let i=0;i<rows.length;i+=B) batches.push(rows.slice(i,i+B));
batches.forEach((b,n)=>fs.writeFileSync(`scripts/analysis/notes-batch-${n}.json`,JSON.stringify(b,null,1)));
console.log(`  ${rows.length} notes -> ${batches.length} batches of ${B}`);
console.log(`  with note text: ${rows.filter(r=>r.note).length}   empty: ${rows.filter(r=>!r.note).length}`);
