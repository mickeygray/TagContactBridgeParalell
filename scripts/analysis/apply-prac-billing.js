"use strict";
/**
 * Mickey 2026-08-05: "Prac Call is its own activity. Red Line is Follow Up On Billing."
 *
 * RED LINES/CHECK IF PAID MO $$$ is a whole category of work that is not tax prep at
 * all — 45 open tickets about declined payments and past-due balances sitting in the
 * same queue as return preparation. It gets its own verb rather than being forced
 * onto one that means something else.
 */
const fs=require("fs");
const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const byKey=new Map(notes.map(n=>[n.jiraKey,n]));

const BUSINESS=/\bbiz\b|\bbusiness\b|\bcorp\b|\bllc\b|\bs-?corp\b|partnership|\b1120\b|\b1065\b/i;
const PRAC=/\bprac\b|practitioner|\bppl\b|priority line/i;
let prac=0,bill=0;
for(const r of rows){
  const n=byKey.get(r.jiraKey); if(!n) continue;
  const note=n.note||"";
  // Billing: the status is the reliable signal; the notes are all declined-payment prose.
  if(/RED LINES/i.test(n.status)){
    r.actionPhrase="Follow Up On Billing";
    r.subject="Follow Up On Billing"; r.outsideRubric=false; r.actionFrom="status"; bill++; continue;
  }
  // Prac call: from the ID-theft status, or from the note naming a prac call, but only
  // where nothing else already claimed the ticket.
  const isPracStatus=/PRAC CALL/i.test(n.status);
  if((isPracStatus||(r.outsideRubric&&PRAC.test(note)))){
    const scope=BUSINESS.test(note)?"Business ":"";
    r.actionPhrase=`${scope}Prac Call`.trim();
    r.subject=r.years?`${r.actionPhrase} For The Years ${r.years}`:r.actionPhrase;
    r.outsideRubric=false; r.actionFrom=isPracStatus?"status":"note"; prac++;
  }
}
console.log(`  Follow Up On Billing: ${bill}   Prac Call: ${prac}\n`);
const p={}; for(const r of rows.filter(x=>x.subject&&!x.outsideRubric)) p[r.actionPhrase||"?"]=(p[r.actionPhrase||"?"]||0)+1;
console.log(`  VOCABULARY across ${rows.length} open issues:`);
for(const [k,n] of Object.entries(p).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
const out=rows.filter(x=>x.outsideRubric);
console.log(`\n  outside: ${out.length}`);
// group the remainder by what it actually is
const G=[[/missing (tax )?years?|midding/i,"missing tax years, waiting on POA"],
         [/ssn|mismatch|name and ssn|info (failed|check)|failed again/i,"SSN / name mismatch (CAF failure)"],
         [/^$/,"empty note"],
         [/update poa/i,"update an existing POA"],
         [/compliant|ran ths \d/i,"statement of fact, no work named"]];
const g={};
for(const r of out){const n=byKey.get(r.jiraKey);const t=(n&&n.note||"").trim();
  const hit=G.find(([re])=>re.test(t)); const k=hit?hit[1]:"other"; (g[k]||(g[k]=[])).push(r.jiraKey);}
for(const [k,v] of Object.entries(g).sort((a,b)=>b[1].length-a[1].length)) console.log(`    ${String(v.length).padStart(4)}  ${k}`);
fs.writeFileSync("scripts/analysis/rubric-subjects-final.json",JSON.stringify(rows,null,1));
