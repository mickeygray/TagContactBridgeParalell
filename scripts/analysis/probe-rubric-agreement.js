const fs=require("fs");
const D="C:/Users/micke/.claude/projects/C--code-TagContactBridgeParalell/31d306a3-0006-4493-8111-a590e12cb807/subagents/workflows/wf_f6e589f8-86a/journal.jsonl";
const L=fs.readFileSync(D,"utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
const readers=L.filter(r=>r.type==="result"&&r.result&&r.result.results).map(r=>r.result.results);
console.log(`  readers: ${readers.length}`);
const notes=new Map(require("./note-sample.json").map(n=>[n.jiraKey,n]));
const ALLOWED=new Set(["Prep Return","Prep Personal Return","Prep Business Return","Prep Personal And Business Return",
  "File Return","File Personal Return","File Business Return","File POA","File Personal POA","File Business POA",
  "Send Return For Signature"]);
const keys=[...new Set(readers.flat().map(r=>r.jiraKey))];
let unanimousFit=0,unanimousOutside=0,split=0,malformed=[];
const outsideActions={},fits=[],splits=[];
for(const k of keys){
  const rs=readers.map(R=>R.find(x=>x.jiraKey===k)).filter(Boolean);
  if(rs.length<readers.length) continue;
  for(const r of rs) if(r.subject&&r.actionPhrase&&!ALLOWED.has(r.actionPhrase))
    malformed.push({k,phrase:r.actionPhrase,subject:r.subject});
  const outs=rs.filter(r=>r.outsideRubric).length;
  if(outs===rs.length){ unanimousOutside++;
    for(const r of rs){const a=(r.actualAction||"?").toLowerCase().trim();outsideActions[a]=(outsideActions[a]||0)+1;}
    continue; }
  if(outs>0){ split++; splits.push({k,note:(notes.get(k)||{}).note,v:rs.map(r=>r.outsideRubric?`OUTSIDE(${r.actualAction})`:r.subject)}); continue; }
  const subs=new Set(rs.map(r=>String(r.subject||"").trim()));
  if(subs.size===1){ unanimousFit++; fits.push({k,note:(notes.get(k)||{}).note,s:[...subs][0]}); }
  else { split++; splits.push({k,note:(notes.get(k)||{}).note,v:[...subs]}); }
}
console.log(`\n  ${keys.length} notes`);
console.log(`    unanimous FIT (identical subject)  ${unanimousFit}`);
console.log(`    unanimous OUTSIDE rubric          ${unanimousOutside}`);
console.log(`    split                             ${split}`);
console.log(`    malformed (phrase not in the 11)  ${malformed.length}`);
for(const m of malformed.slice(0,8)) console.log(`      ${m.k}  "${m.phrase}"  -> ${m.subject}`);
console.log(`\n  WHAT FELL OUTSIDE (reader-reported action, x3 votes):`);
for(const [a,n] of Object.entries(outsideActions).sort((x,y)=>y[1]-x[1]).slice(0,14)) console.log(`    ${String(n).padStart(3)}  ${a}`);
console.log(`\n  SAMPLE FITS:`);
for(const f of fits.slice(0,12)) console.log(`    ${f.s.padEnd(48)} <- "${String(f.note).slice(0,40)}"`);
console.log(`\n  SPLITS:`);
for(const s of splits.slice(0,10)) console.log(`    "${String(s.note).slice(0,46)}"\n        ${s.v.join("\n        ")}`);
