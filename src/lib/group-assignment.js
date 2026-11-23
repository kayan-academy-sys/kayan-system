const {tx}=require('../db');
async function assignGroup({groupId,enrollmentId,orderId}){
 return tx(async c=>{
  const g=(await c.query('SELECT * FROM groups WHERE id=$1 FOR UPDATE',[groupId])).rows[0];
  if(!g||!['open','nearly_full'].includes(g.status))throw Object.assign(Error('المجموعة غير متاحة.'),{status:400});
  const e=(await c.query('SELECT * FROM enrollments WHERE id=$1 FOR UPDATE',[enrollmentId])).rows[0];
  if(!e||e.status!=='active'||e.course_id!==g.course_id||(orderId&&e.order_id!==Number(orderId)))throw Object.assign(Error('التسجيل غير مناسب للمجموعة.'),{status:400});
  const o=(await c.query('SELECT status FROM sales_orders WHERE id=$1 FOR UPDATE',[e.order_id])).rows[0];
  if(o?.status!=='approved')throw Object.assign(Error('الحجز غير معتمد.'),{status:400});
  if(e.group_id===g.id)return {id:e.id,order_id:e.order_id,duplicate:true};
  if(!orderId&&e.group_id)throw Object.assign(Error('حُددت مجموعة التسجيل بالفعل.'),{status:400});
  if((await c.query("SELECT id FROM attendance WHERE enrollment_id=$1 LIMIT 1",[e.id])).rowCount)throw Object.assign(Error('للتسجيل حضور سابق. يلزم مراجعة النقل دون تغيير تاريخه.'),{status:409});
  const n=Number((await c.query("SELECT count(*) AS n FROM enrollments WHERE group_id=$1 AND status='active'",[g.id])).rows[0].n);
  if(n>=g.capacity)throw Object.assign(Error('المجموعة مكتملة العدد.'),{status:409});
  await c.query('UPDATE enrollments SET group_id=$1 WHERE id=$2',[g.id,e.id]);return {id:e.id,order_id:e.order_id};
 });
}
module.exports={assignGroup};
