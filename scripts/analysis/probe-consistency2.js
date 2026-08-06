const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[];for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));
const g={};
for(const r of rows){
  const n=byKey.get(r.jiraKey); if(!n||!n.note) continue;
  const k=`${String(n.status)} :: ${n.note.toLowerCase().replace(/\s+/g," ").trim()}`;
  (g[k]||(g[k]={subs:new Set(),keys:[]}));
  g[k].subs.add(r.subject||"(none)"); g[k].keys.push(r.jiraKey);
}
const bad=Object.entries(g).filter(([,v])=>v.subs.size>1).sort((a,b)=>b[1].keys.length-a[1].keys.length);
const total=Object.keys(g).length;
console.log(`  ${total} distinct (status, note) pairs`);
console.log(`  ${bad.length} of them map to more than one subject\n`);
for(const [k,v] of bad.slice(0,10)){
  console.log(`  "${k.slice(0,62)}"   (${v.keys.length} tickets)`);
  for(const s of v.subs) console.log(`        ${s}`);
}
const affected=bad.reduce((a,[,v])=>a+v.keys.length,0);
console.log(`\n  tickets affected by a genuine inconsistency: ${affected}`);
