const nodemailer = require("nodemailer");

// Sends through the Gmail account set in Vercel (GMAIL_USER + GMAIL_APP_PASSWORD).
let transporter = null;
function getTransporter() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: "smtp.gmail.com",
      port: 465,
      secure: true,
      auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
    });
  }
  return transporter;
}

function codeEmail(code, purpose) {
  const isDelete = purpose === "delete";
  const subject = isDelete
    ? `رمز تأكيد حذف الحساب: ${code} | XtraDrive`
    : `رمز الدخول: ${code} | XtraDrive`;
  const arLine = isDelete ? "رمز تأكيد حذف حسابك في XtraDrive:" : "رمز الدخول إلى XtraDrive:";
  const enLine = isDelete ? "Your XtraDrive account deletion code:" : "Your XtraDrive sign-in code:";
  const text = `${arLine} ${code}\nالرمز صالح لمدة 10 دقائق. إذا لم تطلبه، تجاهل هذه الرسالة.\n\n${enLine} ${code}\nValid for 10 minutes. If you didn't request it, ignore this email.`;
  const html = `
  <div style="font-family:Tahoma,Arial,sans-serif;max-width:480px;margin:auto;padding:24px;color:#14213D">
    <h2 style="margin:0 0 16px">XtraDrive</h2>
    <p dir="rtl" style="text-align:right;margin:0 0 8px">${arLine}</p>
    <p style="font-size:32px;font-weight:bold;letter-spacing:8px;text-align:center;background:#F1F4F9;border-radius:10px;padding:14px;margin:0 0 12px">${code}</p>
    <p dir="rtl" style="text-align:right;color:#56627A;font-size:14px;margin:0 0 20px">الرمز صالح لمدة 10 دقائق. إذا لم تطلبه، تجاهل هذه الرسالة.</p>
    <p style="color:#56627A;font-size:13px;margin:0">${enLine} ${code}<br>Valid for 10 minutes. If you didn't request it, ignore this email.</p>
  </div>`;
  return { subject, text, html };
}

async function sendCodeEmail(to, code, purpose) {
  const { subject, text, html } = codeEmail(code, purpose);
  await getTransporter().sendMail({
    from: `"XtraDrive" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    text,
    html,
  });
}

module.exports = { sendCodeEmail };
