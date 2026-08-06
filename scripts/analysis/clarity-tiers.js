const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
const man=new Map(require("./jira-migration-manifest.json").items.map(i=>[i.jiraKey,i]));
const conflicts=new Set(JSON.parse(fs.readFileSync("scripts/analysis/conflict-keys.json","utf8")));
let notes=[];for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));

const STATUS_ACTION=/^(SENT FOR SIGNATURES|READY TO FILE|HOLD FOR A\/S|run ths)$/i;
const YEARS_ONLY=/^[\s\d,&\/–—-]+$/;
const tier={};
const put=(k,r)=>{(tier[k]||(tier[k]=[])).push(r.jiraKey);};

for(const r of rows){
  const m=man.get(r.jiraKey)||{}; const n=byKey.get(r.jiraKey)||{};
  const note=String(n.note||"").trim();
  if(!m.tenant||!m.caseId){ put("D. no case/tenant — cannot target a Logics case",r); continue; }
  if(!r.subject||r.outsideRubric){ put("D. no subject could be derived",r); continue; }
  if(conflicts.has(r.jiraKey)){ put("C. note contradicts the status — needs a human",r); continue; }

  const statusDrives=STATUS_ACTION.test(String(n.status||"").trim());
  const bareYears=note&&YEARS_ONLY.test(note);
  if(statusDrives&&(bareYears||!note)) put("A. status gives the verb, note is years or empty",r);
  else if(statusDrives) put("B. status gives the verb, note is prose (read for years only)",r);
  else if(bareYears) put("A. note is only years -> Prep Return",r);
  else put("C. note had to be read to find the action",r);
}
const total=rows.length;
const order=Object.keys(tier).sort();
console.log(`  ${total} open Jira issues\n`);
let easy=0;
for(const k of order){
  const n=tier[k].length;
  if(k.startsWith("A.")) easy+=n;
  console.log(`  ${String(n).padStart(4)}  ${(n/total*100).toFixed(1).padStart(5)}%   ${k}`);
}
const b=order.filter(k=>k.startsWith("B.")).reduce((a,k)=>a+tier[k].length,0);
const c=order.filter(k=>k.startsWith("C.")).reduce((a,k)=>a+tier[k].length,0);
const d=order.filter(k=>k.startsWith("D.")).reduce((a,k)=>a+tier[k].length,0);
console.log(`\n  A  deterministic, no judgement   ${easy}  (${(easy/total*100).toFixed(0)}%)`);
console.log(`  B  verb exact, years read        ${b}  (${(b/total*100).toFixed(0)}%)`);
console.log(`  A+B combined                     ${easy+b}  (${((easy+b)/total*100).toFixed(0)}%)`);
console.log(`  C  needed real reading           ${c}  (${(c/total*100).toFixed(0)}%)`);
console.log(`  D  not sure what is going on     ${d}  (${(d/total*100).toFixed(0)}%)`);
