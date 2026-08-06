const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[];for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));
const g={};
for(const r of rows){
  const n=byKey.get(r.jiraKey); if(!n||!n.note) continue;
  const k=n.note.toLowerCase().replace(/\s+/g," ").trim();
  (g[k]||(g[k]=new Set())).add(r.subject||"(none)");
}
const bad=Object.entries(g).filter(([,v])=>v.size>1).sort((a,b)=>b[1].size-a[1].size);
console.log(`  note texts that still map to more than one subject: ${bad.length}`);
for(const [k,v] of bad.slice(0,8)) console.log(`    "${k.slice(0,46)}"\n        ${[...v].join("  |  ")}`);
