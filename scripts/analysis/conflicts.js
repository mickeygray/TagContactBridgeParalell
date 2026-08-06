const fs=require("fs");
const set=JSON.parse(fs.readFileSync("scripts/analysis/final-migration-set.json","utf8")).items;
const dates=new Map(JSON.parse(fs.readFileSync("scripts/analysis/jira-dates.json","utf8")).map(d=>[d.k,d]));
// A note that contradicts the action the status implies.
const RULES=[
  {name:"note says BLOCKED but subject says do it now",
   when:s=>/^(File Return|Follow Up On Signed Returns|Hold For A\/S)/.test(s.subject),
   note:/waiting (on|for)|missing (tax )?years?|\bblocked\b/i},
  {name:"note gives a PREP instruction but status moved past prep",
   when:s=>/^(Follow Up On Signed Returns|File Return)/.test(s.subject),
   note:/\bplease prep\b|\bprep .*(return|with)\b|\bdraft\b/i},
  {name:"THS ordered but the note says the POA is not filed yet",
   when:s=>/^Run THS/.test(s.subject),
   note:/file poa|need poa|waiting (on|for) poa/i},
];
const hits={};let total=0;const seen=new Set();
for(const s of set){
  for(const r of RULES){
    if(!r.when(s)||!r.note.test(s.body||""))continue;
    (hits[r.name]||(hits[r.name]=[])).push(s);
    if(!seen.has(s.jiraKey)){seen.add(s.jiraKey);total++;}
    break;
  }
}
console.log(`  ${total} of ${set.length} carry a note that contradicts the status-derived subject\n`);
for(const [k,v] of Object.entries(hits)){
  console.log(`  ${String(v.length).padStart(4)}  ${k}`);
  for(const s of v.slice(0,3)) console.log(`          ${s.jiraKey.padEnd(15)}${s.subject.slice(0,42).padEnd(44)}"${String(s.body).slice(0,40)}"`);
}
const clean=set.filter(s=>!seen.has(s.jiraKey));
const unconf=clean.filter(s=>s.userIdVerified&&s.userIdVerified!=="confirmed");
console.log(`\n  after removing conflicts:            ${clean.length}`);
console.log(`  of those, unconfirmed Logics UserID: ${unconf.length}`);
console.log(`  fully clean:                         ${clean.length-unconf.length}`);
fs.writeFileSync("scripts/analysis/conflict-keys.json",JSON.stringify([...seen],null,1));
