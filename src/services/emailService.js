'use strict';

const nodemailer = require('nodemailer');
const config = require('../config/env');

// EMAIL_MODE=test uses nodemailer's JSON transport, which formats the message and discards it.
const transporter =
  config.email.mode === 'smtp'
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: { user: config.email.user, pass: config.email.pass },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
      })
    : nodemailer.createTransport({ jsonTransport: true });

async function sendVerificationEmail(toEmail, code) {
  const minutes = Math.round(config.verification.expirySeconds / 60);
  // `code` is always six digits (generated server-side), so it is safe to inline in HTML.
  await transporter.sendMail({
    from: `"${config.appName}" <${config.email.user || 'no-reply@localhost'}>`,
    to: toEmail,
    subject: `Verify your ${config.appName} account`,
    text: `Your verification code is ${code}. It expires in ${minutes} minutes.`,
    html: `
      <div style="font-family: Arial, sans-serif; background:#f4f6f8; padding:30px;">
        <div style="max-width:500px; margin:auto; background:#ffffff; padding:25px; border-radius:12px;">
          <h2 style="text-align:center; color:#333;">Email Verification</h2>
          <p style="font-size:15px; color:#555;">Use the code below to complete your signup.</p>
          <div style="text-align:center; margin:25px 0;">
            <span style="display:inline-block; font-size:26px; letter-spacing:6px; font-weight:bold;
                         background:#f0f0f0; padding:12px 20px; border-radius:8px; color:#111;">${code}</span>
          </div>
          <p style="font-size:14px; color:#777; text-align:center;">
            This code expires in <b>${minutes} minutes</b>.
          </p>
          <hr style="border:none; border-top:1px solid #eee; margin:20px 0;">
          <p style="font-size:12px; color:#999; text-align:center;">
            If you didn't request this email, you can safely ignore it.
          </p>
        </div>
      </div>`,
  });
}

module.exports = { sendVerificationEmail };
