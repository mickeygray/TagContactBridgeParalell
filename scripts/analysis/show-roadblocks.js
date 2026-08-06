const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));
const out=rows.filter(r=>r.outsideRubric);
const rb=out.filter(r=>{const n=byKey.get(r.jiraKey);return n&&/roadblock/i.test(n.status);});
console.log(`  ${rb.length} ROADBLOCK entries still outside the rubric:\n`);
for(const r of rb){
  const n=byKey.get(r.jiraKey);
  console.log(`  ${r.jiraKey.padEnd(16)} "${(n.note||"(EMPTY)").slice(0,72)}"`);
  console.log(`  ${"".padEnd(16)}  -> model read it as: ${r.actualAction||"(unstated)"}`);
}
