const fs=require("fs");
const R=require("./jira-roadblock-routing.json");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));
// sibling info from the earlier cross-reference
const sib=new Map();
for(const b of Object.values(R.buckets)) for(const r of b) if(r.jiraKey&&r.siblings) sib.set(r.jiraKey,{v:r.verdict,s:r.siblings});
const out=rows.filter(x=>x.outsideRubric).filter(r=>/missing (tax )?years?|midding/i.test((byKey.get(r.jiraKey)||{}).note||""));
for(const r of out){
  const nt=byKey.get(r.jiraKey);
  const s=sib.get(r.jiraKey);
  console.log(`  ${r.jiraKey.padEnd(16)}"${String(nt.note).slice(0,44)}"`);
  if(s) console.log(`  ${"".padEnd(16)}POAREQ: ${s.v} -> ${s.s.map(x=>`${x.key} ${x.status}${x.done?" (done "+(x.resolved||"?")+")":" OPEN ["+(x.assignee||"unassigned")+"]"}`).join(", ")||"none"}`);
  else console.log(`  ${"".padEnd(16)}POAREQ: no sibling ticket found for this case`);
}
