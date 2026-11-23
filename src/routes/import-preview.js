const ExcelJS=require('exceljs');
const {validate,importSynthetic}=require('../lib/synthetic-import');
const {q}=require('../db');
async function parseWorkbook(buffer){
 const wb=new ExcelJS.Workbook();await wb.xlsx.load(buffer);
 if(wb.worksheets.length>10)throw Error('عدد أوراق غير صالح');const data={};
 for(const name of ['الطلاب','الكورسات','الحجوزات','التحصيلات','الأقساط']){
  const s=wb.getWorksheet(name);if(!s||s.rowCount>1002||s.columnCount>15)throw Error('ورقة ناقصة أو كبيرة: '+name);
  const headers=s.getRow(2).values.slice(1);data[name]=[];
  for(let n=3;n<=s.rowCount;n++){const row={};for(let k=0;k<headers.length;k++){const value=s.getRow(n).getCell(k+1).value;if(value&&typeof value==='object')throw Error('الصيغ والكائنات غير مسموحة في بيانات الاستيراد');row[headers[k]]=value;}data[name].push(row);}
 }
 validate(data);return data;
}
async function handle(req,res){
 if(process.env.PREVIEW_GATE_REQUIRED!=='1')return res.status(409).render('error',{title:'ممنوع',message:'الاستيراد الوهمي متاح على المعاينة فقط.'});
 try{
  if(!req.file||!req.file.originalname.endsWith('.xlsx'))throw Error('اختر ملف Excel بصيغة xlsx');
  const data=await parseWorkbook(req.file.buffer),summary=validate(data);
  if(req.body.mode!=='apply')return res.render('admin/import-preview',{title:'مراجعة شيت وهمي',summary,result:null,error:null});
  const result=await importSynthetic(data,{actorId:req.user.id,salesId:Number(req.body.sales_id),accountId:Number(req.body.account_id),preview:true});
  res.render('admin/import-preview',{title:'نتيجة الاستيراد الوهمي',summary,result,error:null});
 }catch(e){res.status(400).render('admin/import-preview',{title:'لم يتم الاستيراد',summary:null,result:null,error:e.message});}
}
async function page(req,res){res.render('admin/import-preview',{title:'استيراد Excel وهمي للاختبار',summary:null,result:null,error:null});}
module.exports={handle,page,parseWorkbook};
