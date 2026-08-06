"use strict";
/**
 * Mickey 2026-08-05: "well obviously the year should be read."
 *
 * "MISSING TAX YEARS - WAITING ON POA" carries no years, and that is not an omission —
 * it is the job. Nobody knows which years are missing until the POA is on file and the
 * transcripts can be pulled. So the action is to READ the years off the IRS, which is
 * Run THS, and it belongs to the POA crew.
 *
 * What each ticket needs therefore depends on where its POA actually got to, which the
 * earlier cross-reference already established:
 *
 *   POAREQ closed   -> the POA side is finished. Run THS and read the years.
 *   POAREQ open     -> Riley or Jackie already own it. No second task.
 *   no POAREQ       -> nobody is working the POA at all. File POA first.
 *
 * The closed case carries a caveat that must not be lost: POAREQ has a single "Done"
 * status with no outcome, so closed does NOT prove the POA was filed. These are cases
 * where the two teams disagree, and Run THS is the right next move precisely because
 * it settles the question — if the POA is not really there, the transcript pull fails
 * and says so.
 */
const fs=require("fs");
const R=require("./jira-roadblock-routing.json");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));
const sib=new Map();
for(const b of Object.values(R.buckets)) for(const r of b) if(r.jiraKey&&r.siblings) sib.set(r.jiraKey,r);

const tally={};
for(const r of rows){
  // Deliberately NOT gated on outsideRubric. The first version only reconsidered
  // rows the model had already given up on, so the ones it had confidently labelled
  // "Prep Return" were skipped — and the same sentence ended up with four different
  // subjects across the set. Whether this note becomes Run THS, File POA or nothing
  // depends on the POA's state, never on what a model happened to guess first.
  const note=(byKey.get(r.jiraKey)||{}).note||"";
  if(!/missing (tax )?years?|midding/i.test(note)) continue;
  const s=sib.get(r.jiraKey);
  const openSib=s&&s.siblings.some(x=>!x.done);
  const doneSib=s&&s.siblings.some(x=>x.done);
  let verdict,subject;
  if(openSib){ verdict="POA in progress — already owned, do not migrate"; subject=null; }
  else if(doneSib){ verdict="POA closed — read the years"; subject="Run THS"; }
  else { verdict="no POA ticket exists — file it first"; subject="File POA"; }
  tally[verdict]=(tally[verdict]||0)+1;
  if(subject){ r.actionPhrase=subject; r.subject=subject; r.outsideRubric=false; r.actionFrom="cross-reference"; }
  else {
    // Riley or Jackie already have an open POAREQ for this case. Clearing the
    // subject is the point — leaving whatever the model guessed earlier would post
    // a second task for work already owned, which is the duplicate this whole
    // cross-reference exists to prevent.
    r.subject=null; r.actionPhrase=null; r.outsideRubric=true;
    r.actualAction="already owned by an open POAREQ ticket";
  }
}
for(const [k,v] of Object.entries(tally)) console.log(`  ${String(v).padStart(3)}  ${k}`);
const p={}; for(const r of rows.filter(x=>!x.outsideRubric&&x.subject)){
  const k=x=>x; const key=r.subject.startsWith("Hold For A/S")?"Hold For A/S: File Return":r.actionPhrase;
  p[key]=(p[key]||0)+1;
}
console.log(`\n  FINAL VOCABULARY (${rows.filter(x=>!x.outsideRubric).length} of ${rows.length}):`);
for(const [k,v] of Object.entries(p).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
console.log(`\n  still outside: ${rows.filter(x=>x.outsideRubric).length}`);
fs.writeFileSync("scripts/analysis/rubric-subjects-final.json",JSON.stringify(rows,null,1));
