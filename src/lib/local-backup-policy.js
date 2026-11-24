function canLocalBackup(user){return !!user&&user.active!==false&&[user.role,...(user.extra_roles||[])].some(r=>r==='admin'||r==='general_supervisor');}
function cairoDate(date){return new Intl.DateTimeFormat('en-CA',{timeZone:'Africa/Cairo',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);}
function dueState({now=new Date(),lastConfirmedAt=null}){const today=cairoDate(now);const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Africa/Cairo',hour:'2-digit',hourCycle:'h23'}).format(now));const targetDay=hour>=13?today:cairoDate(new Date(now.getTime()-24*60*60*1000));const latest=lastConfirmedAt?cairoDate(new Date(lastConfirmedAt)):null;return {today,targetDay,due:!latest||latest<targetDay,lastConfirmedAt};}
module.exports={canLocalBackup,dueState};
