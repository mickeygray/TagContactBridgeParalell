require("dotenv").config({ quiet: true });
require("dns").setServers(["8.8.8.8"]);
const fs=require("fs");
const BASE="https://taxadvocategroup.atlassian.net";
const AUTH={Authorization:`Basic ${Buffer.from(`mgray@taxadvocategroup.com:${process.env.JIRA_API_TOKEN}`).toString("base64")}`,Accept:"application/json","Content-Type":"application/json"};
(async()=>{
  const out=[];let k=null;
  do{const p=await(await fetch(`${BASE}/rest/api/3/search/jql`,{method:"POST",headers:AUTH,
    body:JSON.stringify({jql:"project in (ASSIGNMENT, POAREQ, RESO) AND statusCategory != Done",
      maxResults:100,fields:["updated","created","status","summary"],...(k?{nextPageToken:k}:{})})})).json();
    out.push(...(p.issues||[]));k=p.nextPageToken||null;}while(k);
  const d=new Map(out.map(i=>[i.key,{u:Date.parse(i.fields.updated),c:Date.parse(i.fields.created),s:i.fields.status.name}]));
  fs.writeFileSync("scripts/analysis/jira-dates.json",JSON.stringify([...d].map(([k,v])=>({k,...v})),null,1));
  const NOW=Date.parse("2026-08-05"), CUT=NOW-61*86400000;
  const days=t=>Math.round((NOW-t)/86400000);
  const rows=JSON.parse(fs.readFileSync("scripts/analysis/rubric-subjects-final.json","utf8"));
  let notes=[];for(let i=0;i<14;i++) notes=notes.concat(JSON.parse(fs.readFileSync(`scripts/analysis/notes-batch-${i}.json`,"utf8")));
  const byKey=new Map(notes.map(n=>[n.jiraKey,n]));
  const outside=rows.filter(x=>x.outsideRubric);
  const emptyPoa=outside.filter(r=>{const n=byKey.get(r.jiraKey);return n&&!String(n.note||"").trim()&&/POAREQ/.test(r.jiraKey);});
  console.log(`  EMPTY POAREQ tickets (${emptyPoa.length}) — last touched:\n`);
  let stale=0;
  for(const r of emptyPoa.sort((a,b)=>(d.get(a.jiraKey)?.u||0)-(d.get(b.jiraKey)?.u||0))){
    const v=d.get(r.jiraKey); if(!v){console.log(`    ${r.jiraKey}  (no date)`);continue;}
    const old=v.u<CUT; if(old) stale++;
    console.log(`    ${r.jiraKey.padEnd(14)}${v.s.padEnd(11)}updated ${new Date(v.u).toISOString().slice(0,10)} (${String(days(v.u)).padStart(3)}d)  created ${new Date(v.c).toISOString().slice(0,10)}  ${old?"<- CUT":"keep"}`);
  }
  console.log(`\n    2-month cut removes ${stale} of ${emptyPoa.length}\n`);
  const withD=rows.filter(r=>d.get(r.jiraKey));
  const old=withD.filter(r=>d.get(r.jiraKey).u<CUT);
  console.log(`  WIDER: ${old.length} of ${withD.length} open issues untouched in 2 months (${(old.length/withD.length*100).toFixed(0)}%)`);
  const st={};for(const r of old){const v=d.get(r.jiraKey);st[v.s]=(st[v.s]||0)+1;}
  console.log(`\n  stale by status:`);
  for(const [kk,v] of Object.entries(st).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${kk}`);
  const sub={};for(const r of old){const kk=r.subject?(r.subject.startsWith("Hold For A/S")?"Hold For A/S: File Return":r.actionPhrase):"(outside)";sub[kk]=(sub[kk]||0)+1;}
  console.log(`\n  stale by subject:`);
  for(const [kk,v] of Object.entries(sub).sort((a,b)=>b[1]-a[1])) console.log(`    ${String(v).padStart(4)}  ${kk}`);
})().catch(e=>console.error("FAILED "+e.message));
