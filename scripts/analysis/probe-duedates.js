const M=require("./jira-migration-manifest.json");
const i=M.items.find(x=>x.jiraKey==="ASSIGNMENT-2042");
console.log(`  ASSIGNMENT-2042  due ${i.proposed.DueDate}  reminder ${i.proposed.Reminder}`);
console.log(`  source: ${i.dateSource}\n`);
const d={};
for(const x of M.items){ const k=String(x.proposed.DueDate).slice(0,10); d[k]=(d[k]||0)+1; }
console.log(`  due-date distribution across all ${M.items.length} open issues:`);
for(const [k,n] of Object.entries(d).sort((a,b)=>b[1]-a[1]).slice(0,10))
  console.log(`    ${String(n).padStart(4)}  ${k}`);
console.log(`\n  distinct due dates: ${Object.keys(d).length}`);
const top=Object.entries(d).sort((a,b)=>b[1]-a[1])[0];
console.log(`  largest single date: ${top[1]} tasks all due ${top[0]} (${(top[1]/M.items.length*100).toFixed(0)}%)`);
