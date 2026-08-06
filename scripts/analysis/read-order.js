const fs=require("fs");
const p="C:/Users/micke/AppData/Local/Temp/claude/C--code-TagContactBridgeParalell/31d306a3-0006-4493-8111-a590e12cb807/tasks/wxwyd17fg.output";
const s=fs.readFileSync(p,"utf8");
const start=s.indexOf('"result":');
let obj=null;
try{ obj=JSON.parse(s.slice(start+9, s.lastIndexOf("}</result>")+1)); }catch(e){}
if(!obj){
  // fall back: the journal has the clean object
  const D="C:/Users/micke/.claude/projects/C--code-TagContactBridgeParalell/31d306a3-0006-4493-8111-a590e12cb807/subagents/workflows/wf_4b3d94c2-889/journal.jsonl";
  const L=fs.readFileSync(D,"utf8").trim().split("\n").map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean);
  const r=L.filter(x=>x.type==="result").map(x=>x.result).find(x=>x&&x.checklist);
  obj=r;
}
if(!obj){console.log("could not parse");process.exit(0);}
console.log("  CHECKLIST ("+obj.checklist.length+" steps)\n");
for(const c of obj.checklist){
  console.log(`  ${String(c.step).padStart(2)}. [${c.pass}/${c.size}] dep:${c.dependsOn}`);
  console.log(`      ${c.action.replace(/\s+/g," ").slice(0,230)}`);
}
console.log("\n  DELETIONS:");
for(const d of obj.deletions||[]) console.log("    - "+String(d).replace(/\s+/g," ").slice(0,180));
console.log("\n  OPEN QUESTIONS:");
for(const q of obj.openQuestions||[]) console.log("    ? "+String(q).replace(/\s+/g," ").slice(0,190));
