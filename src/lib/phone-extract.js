// استخراج أرقام الموبايل المصرية من نص رسالة: أرقام عربية/فارسية، فواصل، ورموز دولية.
// يخرج الرقم بصيغة محلية 01XXXXXXXXX. غير المؤكد (خطوط أرضية/أجنبي/ناقص) يُحصى ولا يُخمَّن.
const AR = '٠١٢٣٤٥٦٧٨٩', FA = '۰۱۲۳۴۵۶۷۸۹';
const toAscii = s => String(s == null ? '' : s)
  .replace(/[٠-٩]/g, d => AR.indexOf(d)).replace(/[۰-۹]/g, d => FA.indexOf(d))
  .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff\u00a0]/g, ' ');
const VALID = /^(?:(?:00)?20|0)(1[0125]\d{8})$/;
function parseDigits(d) { const m = VALID.exec(d); return m ? '0' + m[1] : null; }

function extractEgyptianMobiles(text) {
  const numbers = []; let skipped = 0;
  const segments = toAscii(text).split(/[^0-9+\-.()\s]+/);
  for (const seg of segments) {
    const tokens = seg.split(/\s+/).map(t => t.replace(/[^0-9]/g, '')).filter(Boolean);
    if (!tokens.length) continue;
    const whole = parseDigits(tokens.join(''));
    if (whole) { numbers.push(whole); continue; }
    let acc = [];
    const flushBad = () => { if (acc.join('').length >= 7) skipped++; acc = []; };
    for (const t of tokens) {
      const single = parseDigits(t);
      if (single) { if (acc.length) flushBad(); numbers.push(single); continue; }
      acc.push(t);
      const joined = parseDigits(acc.join(''));
      if (joined) { numbers.push(joined); acc = []; continue; }
      if (acc.join('').length > 14) { acc.shift(); skipped++; }
    }
    if (acc.length) flushBad();
  }
  return { numbers: [...new Set(numbers)], skipped };
}
function phoneVariants(local) { const n = local.slice(1); return [local, '20' + n, '+20' + n, '0020' + n]; }
function senderDigits(s) { const d = toAscii(s).replace(/[^0-9]/g, ''); return parseDigits(d) ? '20' + parseDigits(d).slice(1) : d; }
module.exports = { toAscii, extractEgyptianMobiles, phoneVariants, senderDigits };
