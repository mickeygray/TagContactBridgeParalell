const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
const manifest=require("./jira-migration-manifest.json");
const man=new Map(manifest.items.map(i=>[i.jiraKey,i]));
let notes=[];for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const noteBy=new Map(notes.map(n=>[n.jiraKey,n]));
const POA=/\bpoa\b|power of attorney|2848|\bths\b|transcript/i;
const list=rows.filter(r=>{
  const m=man.get(r.jiraKey)||{}; if(m.assignee) return false;
  if(!/^ASSIGNMENT-/.test(r.jiraKey)) return false;
  const n=noteBy.get(r.jiraKey)||{};
  return POA.test(n.note||"")||POA.test(r.subject||"");
}).sort((a,b)=>{
  const A=noteBy.get(a.jiraKey)||{},B=noteBy.get(b.jiraKey)||{};
  return String(A.status).localeCompare(String(B.status));
});
console.log(`  ${list.length} unassigned ASSIGNMENT tickets that mention a POA or THS\n`);
let last="";
for(const r of list){
  const n=noteBy.get(r.jiraKey)||{}; const m=man.get(r.jiraKey)||{};
  if(n.status!==last){ console.log(`\n  ── ${n.status} ${"─".repeat(Math.max(0,50-String(n.status).length))}`); last=n.status; }
  console.log(`  ${r.jiraKey.padEnd(16)}${String(m.tenant||"?").padEnd(6)}case ${String(m.caseId||"?").padEnd(8)}`);
  console.log(`      note:    ${n.note||"(EMPTY)"}`);
  console.log(`      subject: ${r.subject||"(none derived)"}`);
}
