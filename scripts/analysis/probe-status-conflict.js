const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));
const LATE={"SENT FOR SIGNATURES":"Send Return For Signature","READY TO FILE":"File Return"};
let conflict=0, agree=0; const detail={};
for(const r of rows){
  const n=byKey.get(r.jiraKey); if(!n) continue;
  const want=LATE[n.status]; if(!want) continue;
  if(r.actionPhrase===want){agree++;continue;}
  conflict++;
  const k=`${n.status}  ->  got "${r.actionPhrase||"(outside)"}"  expected "${want}"`;
  detail[k]=(detail[k]||0)+1;
}
console.log(`  tickets whose STATUS names a late-stage action: ${agree+conflict}`);
console.log(`    subject matches the status : ${agree}`);
console.log(`    subject CONTRADICTS status : ${conflict}\n`);
for(const [k,n] of Object.entries(detail).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
// how many of those have a note that independently says "prep"?
const PREP=/\bprep\b|\bdraft\b|please prepare/i;
const both=rows.filter(r=>{const n=byKey.get(r.jiraKey);return n&&LATE[n.status]&&PREP.test(n.note);});
console.log(`\n  of the conflicts, notes that themselves say prep/draft: ${both.length}`);
for(const r of both.slice(0,6)){const n=byKey.get(r.jiraKey);console.log(`    ${r.jiraKey}  status=${n.status}  note="${n.note.slice(0,52)}"`);}
