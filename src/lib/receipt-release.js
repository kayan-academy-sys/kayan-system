const crypto=require('node:crypto');
function receiptReleaseAllowed(i,env=process.env){if(i.synthetic||env.RECEIPT_WRITES_APPROVED!=='true'||!/^\d+$/.test(env.RECEIPT_APPROVED_TERMS_VERSION||'')||Number(env.RECEIPT_APPROVED_TERMS_VERSION)!==i.terms_version||typeof i.terms!=='string'||!i.terms.trim())return false;const h=env.RECEIPT_APPROVED_TERMS_SHA256||'';return /^[a-f0-9]{64}$/.test(h)&&crypto.timingSafeEqual(Buffer.from(h),Buffer.from(crypto.createHash('sha256').update(i.terms,'utf8').digest('hex')));}
module.exports={receiptReleaseAllowed};
