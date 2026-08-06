const fs=require("fs");
const set=JSON.parse(fs.readFileSync("scripts/analysis/final-migration-set.json","utf8")).items;
const dates=new Map(JSON.parse(fs.readFileSync("scripts/analysis/jira-dates.json","utf8")).map(d=>[d.k,d]));
const pick=[];
// deterministic spread: every Nth of each status-derived kind
for(const kind of ["Follow Up On Signed Returns","Hold For A/S","File Return","Run THS","Follow Up On Billing"]){
  const of=set.filter(s=>s.subject.startsWith(kind));
  for(let i=0;i<of.length&&pick.filter(p=>p.subject.startsWith(kind)).length<4;i+=Math.max(1,Math.floor(of.length/4))) pick.push(of[i]);
}
console.log(`  spot-check ${pick.length} status-derived tasks:\n`);
for(const p of pick){
  const st=dates.get(p.jiraKey);
  console.log(`  ${p.jiraKey.padEnd(15)} jira status: ${String(st?st.s:"?").padEnd(22)}`);
  console.log(`    subject  ${p.subject}`);
  console.log(`    body     "${String(p.body||"(EMPTY)").slice(0,64)}"`);
  console.log(`    due      ${p.dueDate.slice(0,10)}  (${p.dueFrom})`);
}
const empty=set.filter(s=>!s.body);
console.log(`\n  tasks whose BODY would be empty: ${empty.length}`);
for(const e of empty.slice(0,6)) console.log(`    ${e.jiraKey}  ${e.subject}`);
