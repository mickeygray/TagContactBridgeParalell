const r=require("./jira-roadblock-routing.json");
const b=r.buckets.isWork;
const bad=b.filter(x=>/PREP RETURN/.test(x.proposedSubject));
console.log("  full descriptions where the span may be wrong:\n");
for(const x of bad){
  const yrs=(x.description.match(/\b(20\d{2}|\d{2})\b/g)||[]);
  const span=x.proposedSubject.replace("PREP RETURN ","");
  // flag spans wider than the literal years present, or containing a future year
  if(/2026/.test(span)||yrs.length>4){
    console.log(`    ${x.jiraKey}  -> "${span}"`);
    console.log(`       desc: "${x.description.slice(0,110)}"`);
    console.log(`       raw year-ish tokens: ${JSON.stringify(yrs)}`);
  }
}
