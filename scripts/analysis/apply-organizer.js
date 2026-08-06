const fs=require("fs");
const {isOrganizerFollowUp}=require("./organizerRelabel");
const D="C:/Users/micke/.claude/projects/C--code-TagContactBridgeParalell/31d306a3-0006-4493-8111-a590e12cb807/subagents/workflows/wf_a1fcd396-011/journal.jsonl";
const L=fs.readFileSync(D,"utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
let rows=[]; for(const r of L.filter(x=>x.type==="result")) if(r.result&&r.result.results) rows=rows.concat(r.result.results);
let notes=[]; for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const noteBy=new Map(notes.map(n=>[n.jiraKey,n]));

let relabelled=0; const from={};
for(const r of rows){
  const n=noteBy.get(r.jiraKey); if(!n) continue;
  if(!isOrganizerFollowUp(n.note).hit) continue;
  const was=r.outsideRubric?"(outside rubric)":(r.actionPhrase||"?");
  from[was]=(from[was]||0)+1;
  r.actionPhrase="Follow Up On Tax Organizer";
  r.subject=r.years?`Follow Up On Tax Organizer For The Years ${r.years}`:"Follow Up On Tax Organizer";
  r.outsideRubric=false; relabelled++;
}
console.log(`  relabelled ${relabelled} notes -> Follow Up On Tax Organizer`);
console.log(`  they previously were:`);
for(const [k,n] of Object.entries(from).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);

const p={}; for(const r of rows.filter(x=>x.subject&&!x.outsideRubric)) p[r.actionPhrase||"?"]=(p[r.actionPhrase||"?"]||0)+1;
console.log(`\n  FINAL VOCABULARY across ${rows.length} open issues:`);
for(const [k,n] of Object.entries(p).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(n).padStart(4)}  ${k}`);
const out=rows.filter(x=>x.outsideRubric);
console.log(`\n  still outside the rubric: ${out.length}`);
const oa={}; for(const r of out){const k=(r.actualAction||"unstated").toLowerCase().trim().slice(0,52);oa[k]=(oa[k]||0)+1;}
for(const [k,n] of Object.entries(oa).sort((a,b)=>b[1]-a[1]).slice(0,14)) console.log(`    ${String(n).padStart(4)}  ${k}`);
fs.writeFileSync("scripts/analysis/rubric-subjects-final.json",JSON.stringify(rows,null,1));
console.log(`\n  wrote scripts/analysis/rubric-subjects-final.json`);
