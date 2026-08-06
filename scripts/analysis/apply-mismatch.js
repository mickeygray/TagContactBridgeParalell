"use strict";
/**
 * Mickey 2026-08-05: "ssn mismatch is Review Client Info For POA (ssn mismatch etc)."
 *
 * Six open tickets are stuck on the same IRS failure: the name and SSN on file do not
 * match what the IRS holds, so the CAF rejects the POA and the transcript pull fails.
 * The work is not filing anything again — it is checking the client's details before
 * a re-file can succeed. "etc" is doing real work in that instruction: the notes say
 * this several different ways ("keeps saying ssn/name mismatch", "need to check the
 * name and ssn", "failed again, waiting to see the info check"), and they are all the
 * same job.
 */
const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));

/** The several ways this shop writes the same CAF rejection. */
const MISMATCH=/ssn\s*\/?\s*name mismatch|name\s*\/?\s*ssn mismatch|mismatch|check the name and ssn|verify (the )?client.?s? info|info (failed|check)|failed again|caf (failure|reject)/i;

let n=0;
for(const r of rows){
  if(!r.outsideRubric) continue;
  const note=(byKey.get(r.jiraKey)||{}).note||"";
  if(!MISMATCH.test(note)) continue;
  r.actionPhrase="Review Client Info For POA";
  r.subject="Review Client Info For POA";
  r.outsideRubric=false; r.actionFrom="note"; n++;
}
console.log(`  ${n} -> Review Client Info For POA\n`);
const p={}; for(const r of rows.filter(x=>x.subject&&!x.outsideRubric)) p[r.actionPhrase||"?"]=(p[r.actionPhrase||"?"]||0)+1;
console.log(`  VOCABULARY across ${rows.length} open issues (${rows.filter(x=>!x.outsideRubric).length} with a subject):`);
for(const [k,v] of Object.entries(p).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
const out=rows.filter(x=>x.outsideRubric);
console.log(`\n  outside: ${out.length}`);
for(const r of out){const nt=(byKey.get(r.jiraKey)||{});
  console.log(`    ${r.jiraKey.padEnd(16)}${String(nt.status).padEnd(22)}"${String(nt.note||"(EMPTY)").slice(0,50)}"`);}
fs.writeFileSync("scripts/analysis/rubric-subjects-final.json",JSON.stringify(rows,null,1));
