"use strict";
/**
 * apply-status-actions — let the Jira STATUS choose the verb for late-stage work.
 *
 * The full model pass took the action from the note and used status only to record
 * blockers. That produced 272 of 278 late-stage tickets labelled "Prep Return" —
 * ordering preparation of returns that are already drafted, already out for
 * signature, or ready to transmit.
 *
 * The fix is a division of labour rather than a better prompt. The status is a
 * controlled field with a handful of values, so mapping it to a verb is exact and
 * needs no judgement. The years live in free text, which is where reading is
 * genuinely required and where the model measured strongest — it correctly excluded
 * prose dates ("assessed in June of 2026"), balance-owed ranges ("they owe from
 * 2018-2020") and preserved gap ranges verbatim ("2018, 2020-2025").
 *
 * So: status picks the verb, the note supplies the years.
 *
 * Mickey 2026-08-05: "sent for signature is different than send for signature. Sent
 * can be Follow Up On Signed Returns for tax year." Past tense — the returns already
 * went to the client and the job is chasing them back, which is the same shape as
 * Follow Up On Tax Organizer, not the same as sending them out in the first place.
 */
const fs=require("fs");

/**
 * Only statuses that unambiguously name a stage of the return's life. To Do and
 * ROADBLOCK say nothing about the work, so those keep the note-derived action.
 * HOLD FOR A/S is deliberately absent — it names a team, not an action, and Mickey
 * has not ruled on what it should say.
 */
const STATUS_ACTION={
  "SENT FOR SIGNATURES":"Follow Up On Signed Returns",
  "READY TO FILE":"File Return",
  "run ths":"Run THS",
};

const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));

let changed=0; const from={};
for(const r of rows){
  const n=byKey.get(r.jiraKey); if(!n) continue;
  const action=STATUS_ACTION[n.status]; if(!action) continue;
  if(r.actionPhrase===action) continue;
  from[`${n.status}: was ${r.actionPhrase||"(outside)"}`]=(from[`${n.status}: was ${r.actionPhrase||"(outside)"}`]||0)+1;
  r.actionPhrase=action;
  // Keep the years the model read out of the note — that part held up under audit.
  r.subject=r.years?`${action} For The Years ${r.years}`:action;
  r.outsideRubric=false;
  r.actionFrom="status";
  changed++;
}
console.log(`  ${changed} subjects re-derived from status\n`);
for(const [k,v] of Object.entries(from).sort((a,b)=>b[1]-a[1]).slice(0,10)) console.log(`    ${String(v).padStart(4)}  ${k}`);

const p={}; for(const r of rows.filter(x=>x.subject&&!x.outsideRubric)) p[r.actionPhrase||"?"]=(p[r.actionPhrase||"?"]||0)+1;
console.log(`\n  VOCABULARY across ${rows.length} open issues:`);
for(const [k,n] of Object.entries(p).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
const out=rows.filter(x=>x.outsideRubric);
console.log(`\n  outside the rubric: ${out.length}`);
const st={}; for(const r of out){const n=byKey.get(r.jiraKey);st[n?n.status:"?"]=(st[n?n.status:"?"]||0)+1;}
console.log(`    by status: ${Object.entries(st).sort((a,b)=>b[1]-a[1]).map(([k,v])=>`${k}=${v}`).join(", ")}`);
fs.writeFileSync("scripts/analysis/rubric-subjects-final.json",JSON.stringify(rows,null,1));
console.log(`\n  sample:`);
for(const r of rows.filter(x=>x.actionFrom==="status").slice(0,8)){const n=byKey.get(r.jiraKey);
  console.log(`    ${String(n.status).padEnd(21)} "${String(n.note).slice(0,16).padEnd(16)}" -> ${r.subject}`);}
