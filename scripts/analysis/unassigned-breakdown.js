const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
const manifest=require("./jira-migration-manifest.json");
const man=new Map(manifest.items.map(i=>[i.jiraKey,i]));
let notes=[];for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const noteBy=new Map(notes.map(n=>[n.jiraKey,n]));

const un=rows.filter(r=>{const m=man.get(r.jiraKey)||{};return !m.assignee;});
console.log(`  ${un.length} unassigned open issues\n`);

const POA=/\bpoa\b|power of attorney|2848|\bths\b|transcript/i;
const poaRelated=un.filter(r=>{
  const n=noteBy.get(r.jiraKey)||{};
  return /POAREQ/.test(r.jiraKey) || POA.test(n.note||"") || POA.test(r.subject||"");
});
console.log(`  POA-related (POAREQ project, or note/subject mentions POA or THS): ${poaRelated.length}\n`);

const proj={},sub={},st={};
for(const r of poaRelated){
  const p=r.jiraKey.split("-")[0]; proj[p]=(proj[p]||0)+1;
  const k=r.subject?r.subject.replace(/ For The Years.*/,""):"(no subject)"; sub[k]=(sub[k]||0)+1;
  const n=noteBy.get(r.jiraKey)||{}; st[n.status]=(st[n.status]||0)+1;
}
console.log(`  by project: ${Object.entries(proj).map(([k,v])=>`${k}=${v}`).join("  ")}`);
console.log(`  by status:  ${Object.entries(st).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join("  ")}`);
console.log(`\n  by subject:`);
for(const [k,v] of Object.entries(sub).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);

const rest=un.filter(r=>!poaRelated.includes(r));
const rsub={},rst={};
for(const r of rest){const k=r.subject?r.subject.replace(/ For The Years.*/,""):"(no subject)";rsub[k]=(rsub[k]||0)+1;
  const n=noteBy.get(r.jiraKey)||{};rst[n.status]=(rst[n.status]||0)+1;}
console.log(`\n  the other ${rest.length} unassigned (not POA-related):`);
console.log(`    by status:  ${Object.entries(rst).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join("  ")}`);
for(const [k,v] of Object.entries(rsub).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
