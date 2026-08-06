const fs=require("fs");
let rows=[];
for(let i=0;i<14;i++) rows=rows.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
const TO=/\bt\.?\s?o\.?\b|tax organizer|organizer/i;
const DOCS=/\bdocs?\b|document|paperwork/i;
const hitTO=rows.filter(r=>TO.test(r.note));
const hitDocs=rows.filter(r=>DOCS.test(r.note));
const either=rows.filter(r=>TO.test(r.note)||DOCS.test(r.note));
console.log(`  of ${rows.length} open notes:`);
console.log(`    mention T.O. / organizer : ${hitTO.length}`);
console.log(`    mention docs            : ${hitDocs.length}`);
console.log(`    either                  : ${either.length}`);
const st={}; for(const r of either) st[r.status]=(st[r.status]||0)+1;
console.log(`\n  by Jira status: ${Object.entries(st).sort((a,b)=>b[1]-a[1]).map(([k,n])=>`${k}=${n}`).join(", ")}`);
console.log(`\n  what they actually say (top phrasings):`);
const f={}; for(const r of either){const k=r.note.toLowerCase().replace(/\d{2,4}/g,"YYYY").replace(/[^a-z\s.]/g," ").replace(/\s+/g," ").trim().slice(0,52);f[k]=(f[k]||0)+1;}
for(const [k,n] of Object.entries(f).sort((a,b)=>b[1]-a[1]).slice(0,16)) console.log(`    ${String(n).padStart(3)}  "${k}"`);
