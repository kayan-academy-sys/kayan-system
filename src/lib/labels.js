module.exports = {
  leadStatus: {
    new: 'جديد', no_answer: 'لا يرد', interested: 'مهتم', need_follow_up: 'يحتاج متابعة',
    closed_lost: 'خسرنا العميل', booked_cash: 'حجز نقدي', booked_installment: 'حجز بالتقسيط'
  },
  leadSource: { whatsapp: 'واتساب', facebook: 'فيسبوك', instagram: 'إنستجرام', tiktok: 'تيك توك', website: 'الموقع', manual: 'إدخال يدوي', other: 'أخرى' },
  groupStatus: { draft: 'مسودة', open: 'متاحة للحجز', nearly_full: 'قاربت على الاكتمال', full: 'مكتملة', running: 'جارية', finished: 'منتهية', cancelled: 'ملغاة' },
  sessionStatus: { scheduled: 'مجدولة', done: 'تمت', postponed: 'مؤجلة', cancelled: 'ملغاة' },
  paymentMethod: { cash: 'نقدي', bank_transfer: 'تحويل بنكي', instapay: 'إنستاباي', wallet: 'محفظة إلكترونية' },
  accountType: { cash: 'خزينة', bank: 'حساب بنكي', instapay: 'إنستاباي', wallet: 'محفظة إلكترونية' },
  attendanceStatus: { present: 'حاضر', absent: 'غائب', late: 'متأخر', excused: 'غياب بعذر' },
  orderStatus: { pending: 'بانتظار الاعتماد', approved: 'معتمد', cancelled: 'ملغي' },
  activityType: { call: 'مكالمة', note: 'ملاحظة', follow_up: 'متابعة', status_change: 'تغيير حالة' }
};
