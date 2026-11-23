CREATE SEQUENCE invoice_serial_seq;
CREATE TABLE invoices (
 id BIGSERIAL PRIMARY KEY,
 serial_no BIGINT NOT NULL UNIQUE DEFAULT nextval('invoice_serial_seq'),
 issue_date DATE NOT NULL DEFAULT current_date,
 customer_name TEXT NOT NULL,
 customer_mobile TEXT,
 amount_pounds INT NOT NULL CHECK(amount_pounds BETWEEN 0 AND 999999999),
 amount_piastres INT NOT NULL DEFAULT 0 CHECK(amount_piastres BETWEEN 0 AND 99),
 purpose TEXT NOT NULL,
 offer_type TEXT,
 terms TEXT NOT NULL,
 terms_version INT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','confirmed','voided')),
 sales_user_id INT REFERENCES users(id),
 created_by INT REFERENCES users(id),
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 CHECK(amount_pounds>0 OR amount_piastres>0)
);
INSERT INTO settings(key,value) VALUES ('invoice_terms_version','1'::jsonb) ON CONFLICT DO NOTHING;
INSERT INTO settings(key,value) VALUES ('invoice_terms',to_jsonb($TERMS$يحق للمتدرب استرداد كامل المبلغ في حالة تأخر بدء الدورة بـ 30 يوم عن المعاد المتفق عليه.
يحق للمتدرب الغاء الدورة قبل 15 يوما من بدايتها ويتم استرداد نصف المبلغ المدفوع فقط.
في حالة غياب المتدرب او تخلفه عن حضور محاضرة المركز غير ملزم بتعويض المحاضرة أو التعويض المادي.
في حالة تخلف المتدرب عن تسليم 3 تاسكات متواصلين خلال الدورة يتم الغاء الدورة بالكامل ولا يحق للمتدرب استرداد اي رسوم.
لا يمكن استبدال دورة بدورة أخرى حتى بعد استلام ايصال الدفع.
لكي يحصل المتدرب علي شهادة يجب عليه حضور أكثر من 80٪ من عدد المحاضرات وتسلم بنهاية الدورة.
لا يمكن تغير مواعيد الدورة التي تم الاتفاق عليها مع المركز لإلتزام المركز بدورات أخرى
بهذه الفاتورة يسمح للمتدرب بدخول دوره واحده فقط ولا يسمح بتأجيل الدورة بعد بدايتها وتصبح الفاتورة ملغية.
اقصي مدة للتأجيل هي 6 شهور فقط ولا يحق له الاسترداد
لا يحق للمتدرب الحصول على المادة العلمية أو الشهادة الا بعد استكمال المبلغ الخاص بالدورة.
يجب الاحتفاظ بهذه الفاتورة طوال فترة الدورة وتقديمها عند الطلب.
في حين تفعيل نظام التقسيط يتم السداد وفقا للمواعيد المتفق عليها وعند التخلف عن السداد في اي من المواعيد المتفق عليها يتم اخذ الاجراءات اللازمه وايقاف الدوره الخاص بك.
عند تأجيل الدورة بعد تحديد الميعاد المتفق عليه يتم اضافة مبلغ 1000 جنية رسوم لدخول دورة أخري.
يمنع تماما تسجيل المحاضرات خلال البث المباشر وفي حالة تسجيل المحاضرة يتم الغاء الدورة التدريبية دون رد المبلغ في حين ان المركز يتعهد بارسال فيديوهات لشرح الدورة التدريبية في حين تسديد سعر الدورة كاملا.
في حالة استرداد المبلغ في اطار البنود المذكورة اعلاه يتم تقديم طلب للموظف المختص وسيتم الرد خلال 72 ساعة بحد اقصي علي ان يتم ذلك داخل المؤسسة بعد توقيع العميل علي ايصال باسترداد المبلغ.$TERMS$::text)) ON CONFLICT DO NOTHING;
