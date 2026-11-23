const {test}=require('node:test');const assert=require('node:assert/strict');const {amountInWords,tafqeet}=require('../src/lib/tafqeet');
test('currency words: zero, singular, dual, plural and piastres',()=>{
 const cases=[[0,0,'صفر جنيه فقط لا غير'],[1,0,'جنيه واحد فقط لا غير'],[2,0,'جنيهان فقط لا غير'],[200,0,'مائتا جنيه فقط لا غير'],[2000,0,'ألفا جنيه فقط لا غير'],[2000000,0,'مليونا جنيه فقط لا غير'],[3,0,'ثلاثة جنيهات فقط لا غير'],[10,0,'عشرة جنيهات فقط لا غير'],[11,0,'أحد عشر جنيه فقط لا غير'],[500,25,'خمسمائة جنيه وخمسة وعشرون قرش فقط لا غير'],[0,1,'قرش واحد فقط لا غير'],[0,2,'قرشان فقط لا غير'],[0,5,'خمسة قروش فقط لا غير'],[1,50,'جنيه واحد وخمسون قرش فقط لا غير']];for(const [g,p,s]of cases)assert.equal(amountInWords(g,p),s);
});
test('no silent rounding or sub-piastre truncation',()=>{
 for(const [g,p]of [[1.1,0],[1,0.1],[1,100],[-1,0],[Infinity,0],[1000000000,0]])assert.throws(()=>amountInWords(g,p),RangeError);
 assert.equal(amountInWords(0,99),'تسعة وتسعون قرش فقط لا غير');
});
test('large number groups stay distinct',()=>{
 assert.equal(tafqeet(3500),'ثلاثة آلاف وخمسمائة');assert.equal(tafqeet(1000000),'مليون');assert.equal(tafqeet(1234567),'مليون ومائتان وأربعة وثلاثون ألف وخمسمائة وسبعة وستون');
});
