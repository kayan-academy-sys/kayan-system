// تفقيط الأرقام إلى كلمات عربية لسطر «ومبلغ وقدره» في إيصال الاستلام
const ONES = ['', 'واحد', 'اثنان', 'ثلاثة', 'أربعة', 'خمسة', 'ستة', 'سبعة', 'ثمانية', 'تسعة', 'عشرة',
  'أحد عشر', 'اثنا عشر', 'ثلاثة عشر', 'أربعة عشر', 'خمسة عشر', 'ستة عشر', 'سبعة عشر', 'ثمانية عشر', 'تسعة عشر'];
const TENS = ['', 'عشرة', 'عشرون', 'ثلاثون', 'أربعون', 'خمسون', 'ستون', 'سبعون', 'ثمانون', 'تسعون'];
const HUNDREDS = ['', 'مائة', 'مائتان', 'ثلاثمائة', 'أربعمائة', 'خمسمائة', 'ستمائة', 'سبعمائة', 'ثمانمائة', 'تسعمائة'];

function under100(n) {
  if (n < 20) return ONES[n];
  const o = n % 10;
  const t = Math.floor(n / 10);
  return o ? ONES[o] + ' و' + TENS[t] : TENS[t];
}

function under1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  const parts = [];
  if (h) parts.push(HUNDREDS[h]);
  if (r) parts.push(under100(r));
  return parts.join(' و');
}

function scaleWord(n, one, two, few, many) {
  if (n === 1) return one;
  if (n === 2) return two;
  if (n >= 3 && n <= 10) return ONES[n] + ' ' + few;
  return under1000(n) + ' ' + many;
}

function tafqeet(n) {
  n = Math.floor(Math.abs(Number(n) || 0));
  if (n === 0) return 'صفر';
  const parts = [];
  const m = Math.floor(n / 1000000);
  const rest = n % 1000000;
  const th = Math.floor(rest / 1000);
  const u = rest % 1000;
  if (m) parts.push(scaleWord(m, 'مليون', 'مليونان', 'ملايين', 'مليون'));
  if (th) parts.push(scaleWord(th, 'ألف', 'ألفان', 'آلاف', 'ألف'));
  if (u) parts.push(under1000(u));
  return parts.join(' و');
}

// سطر المبلغ كتابةً كما في إيصال المركز: «ثلاثة آلاف وخمسمائة جنيه فقط لا غير»
function currencyWords(n, singular, dual, plural) {
  if(n===1)return singular+' واحد';
  if(n===2)return dual;
  if(n>=3 && n<=10)return tafqeet(n)+' '+plural;
  return tafqeet(n).replace(/مائتان$/,'مائتا').replace(/ألفان$/,'ألفا').replace(/مليونان$/,'مليونا')+' '+singular;
}
function amountInWords(pounds, piastres) {
  const g=Number(pounds),p=Number(piastres);
  if(!Number.isSafeInteger(g)||g<0||g>999999999||!Number.isInteger(p)||p<0||p>99)throw new RangeError('Expected integer pounds and piastres 0..99');
  const parts=[];
  if(g>0 || p===0)parts.push(currencyWords(g,'جنيه','جنيهان','جنيهات'));
  if(p>0)parts.push(currencyWords(p,'قرش','قرشان','قروش'));
  return parts.join(' و')+' فقط لا غير';
}
module.exports = { tafqeet, amountInWords };
