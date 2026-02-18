import nodemailer from 'nodemailer';

// Create nodemailer transporter with Gmail SMTP
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_PASS,
  },
});

// Send OTP email for password reset
export async function sendPasswordResetOTP(email: string, otp: string): Promise<boolean> {
  try {
    const mailOptions = {
      from: `"Zorli AI Vault" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'Password Reset Code - Zorli AI Vault',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #333;">Password Reset Request</h2>
          <p>You have requested to reset your password for Zorli AI Vault.</p>
          <p>Your password reset code is:</p>
          <div style="background-color: #f5f5f5; padding: 15px; text-align: center; margin: 20px 0;">
            <h1 style="color: #007AFF; margin: 0; letter-spacing: 5px;">${otp}</h1>
          </div>
          <p><strong>This code will expire in 10 minutes.</strong></p>
          <p>If you did not request this password reset, please ignore this email.</p>
          <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
          <p style="color: #666; font-size: 12px;">
            This is an automated email from Zorli AI Vault. Please do not reply to this email.
          </p>
        </div>
      `,
      text: `Your password reset code is ${otp}. This code will expire in 10 minutes.`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Password reset email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('❌ Failed to send password reset email:', error);
    return false;
  }
}

// Send email verification link
export async function sendVerificationEmail(email: string, verificationToken: string, baseUrl: string): Promise<boolean> {
  try {
    const verificationLink = `${baseUrl}/verify-email?token=${verificationToken}`;
    
    const mailOptions = {
      from: `"Zorli AI Vault" <${process.env.GMAIL_USER}>`,
      to: email,
      subject: 'Verify Your Email - Zorli AI Vault',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="text-align: center; margin-bottom: 30px;">
            <h1 style="color: #007AFF; margin: 0;">Welcome to Zorli AI Vault!</h1>
          </div>
          
          <h2 style="color: #333;">Verify Your Email Address</h2>
          <p>Thank you for signing up! Please verify your email address to get started with Zorli AI Vault.</p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationLink}" 
               style="background-color: #007AFF; 
                      color: white; 
                      padding: 14px 28px; 
                      text-decoration: none; 
                      border-radius: 8px; 
                      font-weight: 600;
                      display: inline-block;">
              Verify & Login
            </a>
          </div>
          
          <p style="color: #666; font-size: 14px;">Or copy and paste this link into your browser:</p>
          <p style="background-color: #f5f5f5; padding: 10px; border-radius: 4px; word-break: break-all; font-size: 12px;">
            ${verificationLink}
          </p>
          
          <p style="color: #FF3B30; font-weight: 600; margin-top: 20px;">
            ⏱️ This link will expire in 30 minutes.
          </p>
          
          <p style="margin-top: 30px;">If you did not create an account with Zorli AI Vault, please ignore this email.</p>
          
          <hr style="border: none; border-top: 1px solid #ddd; margin: 30px 0;">
          <p style="color: #666; font-size: 12px;">
            This is an automated email from Zorli AI Vault. Please do not reply to this email.
          </p>
        </div>
      `,
      text: `Welcome to Zorli AI Vault! Please verify your email address by clicking this link: ${verificationLink}\n\nThis link will expire in 30 minutes.\n\nIf you did not create an account, please ignore this email.`,
    };

    const info = await transporter.sendMail(mailOptions);
    console.log('✅ Verification email sent:', info.messageId);
    return true;
  } catch (error) {
    console.error('❌ Failed to send verification email:', error);
    return false;
  }
}

// Verify transporter configuration
export async function verifyEmailConfig(): Promise<boolean> {
  try {
    await transporter.verify();
    console.log('✅ Email transporter verified successfully');
    return true;
  } catch (error) {
    console.error('❌ Email transporter verification failed:', error);
    return false;
  }
}
