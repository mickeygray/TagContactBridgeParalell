"use strict";
/**
 * Mickey 2026-08-05: "Hold for A/S should be the first part of the subject but still
 * have file 2025 return."
 *
 * HOLD FOR A/S is not an action, it is a place the work is sitting — with the
 * audit/settlement team. So unlike SENT FOR SIGNATURES (where the status REPLACED the
 * verb), here the status PREFIXES it. The return still has to be filed; it is just
 * held first. That keeps both facts in the label: why it is not moving, and what
 * happens when it does.
 */
const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));

let n=0;
for(const r of rows){
  const nt=byKey.get(r.jiraKey); if(!nt||nt.status!=="HOLD FOR A/S") continue;
  // The work behind an A/S hold is filing the return, not preparing it again.
  const action=r.years?`File Return For The Years ${r.years}`:"File Return";
  r.actionPhrase="File Return";
  r.subject=`Hold For A/S: ${action}`;
  r.outsideRubric=false; r.actionFrom="status+note"; n++;
}
console.log(`  ${n} HOLD FOR A/S tickets re-subjected\n`);
for(const r of rows.filter(x=>x.actionFrom==="status+note").slice(0,6)){
  const nt=byKey.get(r.jiraKey);
  console.log(`    note "${String(nt.note||"").slice(0,14).padEnd(14)}" -> ${r.subject}`);
}
const p={}; for(const r of rows.filter(x=>x.subject&&!x.outsideRubric)) p[(r.subject.split(":")[0].includes("Hold")?"Hold For A/S: File Return":r.actionPhrase)||"?"]=(p[(r.subject.split(":")[0].includes("Hold")?"Hold For A/S: File Return":r.actionPhrase)||"?"]||0)+1;
console.log(`\n  VOCABULARY (${rows.filter(x=>!x.outsideRubric).length} of ${rows.length} have a subject):`);
for(const [k,v] of Object.entries(p).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
fs.writeFileSync("scripts/analysis/rubric-subjects-final.json",JSON.stringify(rows,null,1));
