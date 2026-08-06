const fs=require("fs");
const M=require("./jira-migration-manifest.json");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));
const man=new Map(M.items.map(i=>[i.jiraKey,i]));
const CUT=Date.parse("2026-06-05");           // two months before 2026-08-05
const age=k=>{const m=man.get(k);return m&&m.updated?Date.parse(m.updated):null;};
const days=t=>Math.round((Date.parse("2026-08-05")-t)/86400000);

const outside=rows.filter(x=>x.outsideRubric);
const emptyPoa=outside.filter(r=>{const n=byKey.get(r.jiraKey);return n&&!String(n.note||"").trim()&&/POAREQ/.test(r.jiraKey);});
console.log(`  EMPTY POAREQ tickets: ${emptyPoa.length}`);
let stale=0;
for(const r of emptyPoa){
  const t=age(r.jiraKey); const old=t&&t<CUT; if(old) stale++;
  console.log(`    ${r.jiraKey.padEnd(14)}${(byKey.get(r.jiraKey)||{}).status.padEnd(12)}last updated ${t?new Date(t).toISOString().slice(0,10):"?"}  ${t?days(t)+"d ago":""}  ${old?"<- CUT":""}`);
}
console.log(`\n    a 2-month cut removes ${stale} of ${emptyPoa.length}\n`);

console.log(`  SAME CUT APPLIED WIDER:`);
const buckets=[["all 809 open issues",rows],["the 24 still outside",outside]];
for(const [label,set] of buckets){
  const withDate=set.filter(r=>age(r.jiraKey));
  const old=withDate.filter(r=>age(r.jiraKey)<CUT);
  console.log(`    ${label.padEnd(24)} ${old.length} of ${withDate.length} untouched since 2026-06-05 (${(old.length/Math.max(withDate.length,1)*100).toFixed(0)}%)`);
}
// where does the stale work sit?
const st={};
for(const r of rows){const t=age(r.jiraKey);if(!t||t>=CUT)continue;const n=byKey.get(r.jiraKey);st[n?n.status:"?"]=(st[n?n.status:"?"]||0)+1;}
console.log(`\n  stale work by status:`);
for(const [k,v] of Object.entries(st).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
