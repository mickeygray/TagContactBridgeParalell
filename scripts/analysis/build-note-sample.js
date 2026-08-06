const fs=require("fs");
const {deriveSubject}=require("./taskSubject");
const M=require("./jira-migration-manifest.json");
const R=require("./jira-roadblock-routing.json");
const desc=new Map();
for(const b of Object.values(R.buckets)) for(const r of b) if(r.jiraKey) desc.set(r.jiraKey,r.description||"");
// stratify: make sure every shape is represented, not just the common one
const shapes={yearsOnly:[],poaAsk:[],poaStatement:[],prose:[],docs:[],empty:[],statusLed:[]};
for(const i of M.items){
  const d=(desc.get(i.jiraKey) ?? String(i.proposed.Comments||"").split("\n")[0]).trim();
  const rec={jiraKey:i.jiraKey,status:i.status,note:d,ruleSubject:deriveSubject(d,i.status).subject};
  if(!d||d.startsWith("(no detail")) {shapes.empty.push(rec);continue;}
  const stateY=/^(to do|to do'?s|roadblock)$/i.test(i.status);
  if(!stateY){ shapes.statusLed.push(rec); continue; }
  if(/\bpoa\b/i.test(d)&&/\bin logics\b|already|filed|on file|received/i.test(d)) shapes.poaStatement.push(rec);
  else if(/\bpoa\b/i.test(d)) shapes.poaAsk.push(rec);
  else if(/^[\s\d,&/–—-]+$/.test(d)) shapes.yearsOnly.push(rec);
  else if(/\bdocs?\b|waiting/i.test(d)) shapes.docs.push(rec);
  else shapes.prose.push(rec);
}
const take={yearsOnly:6,poaAsk:8,poaStatement:8,prose:10,docs:6,empty:2,statusLed:8};
const sample=[];
for(const [k,n] of Object.entries(take)){
  console.log(`  ${k.padEnd(14)} pool ${String(shapes[k].length).padStart(4)}  taking ${Math.min(n,shapes[k].length)}`);
  sample.push(...shapes[k].slice(0,n).map(r=>({...r,shape:k})));
}
fs.writeFileSync("scripts/analysis/note-sample.json",JSON.stringify(sample,null,2));
console.log(`\n  wrote ${sample.length} notes to scripts/analysis/note-sample.json`);
