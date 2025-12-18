require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const multer = require('multer');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 5000;
const UPLOAD_DIR = path.join(__dirname, 'uploads');


let db;
let smtp;


if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

// Validate required environment variables
const required = [
  'MONGODB_URI',
  'FROM_EMAIL',
  'FROM_NAME',
  'EMAIL_USER',
  'EMAIL_PASS',
  'ADMIN_EMAIL',
  'PUBLISH_SECRET',
  'TEMP'
];

for (const k of required) {
  if (!process.env[k]) {
    console.error(`Missing env var: ${k}`);
    process.exit(1);
  }
}

// MongoDB connection
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'),
   db='DB connection established.'
)
  .catch(err => {
    console.error(err.message);
    process.exit(1);
  });

// Subscriber schema
const subscriberSchema = new mongoose.Schema({
  email: { type: String, unique: true, required: true },
  name: String,
  createdAt: { type: Date, default: Date.now }
});
const Subscriber = mongoose.model('Subscriber', subscriberSchema);

// Post schema to store published posts
const postSchema = new mongoose.Schema({
  title: { type: String, required: true },
  excerpt: String,
  content: String,
  postUrl: { type: String, required: true },
  attachmentUrl: String,
  attachmentName: String,
  sendFull: { type: Boolean, default: false },
  publishedAt: { type: Date, default: Date.now }
});
const Post = mongoose.model('Post', postSchema);

// Middleware
app.use(helmet());
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use('/uploads', express.static(UPLOAD_DIR));

// Rate limiting
app.use('/subscribe', rateLimit({
  windowMs: 60000,
  max: 12
}));

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Verify SMTP connection
(async () => {
  try {
    await transporter.verify();
    console.log('SMTP ready');
    smtp='SMTP connection established.'
  } catch (e) {
    console.error('SMTP connection error:', e.message);
  }
})();

// Helper function to send emails
async function safeSend(mail) {
  try {
    await transporter.sendMail(mail);
    return true;
  } catch (e) {
    console.error('Email send error:', e.message);
    return false;
  }
}

// Helper to normalize email
const normEmail = e => String(e).trim().toLowerCase();

// Routes


// Get all subscribers
app.get('/_subs', async (req, res) => {
  try {
    const subs = await Subscriber.find(
      {},
      { _id: 0, email: 1, name: 1, createdAt: 1 }
    ).sort({ createdAt: -1 });
    res.json(subs);
  } catch (err) {
    console.error('Error fetching subscribers:', err);
    res.status(500).json([]);
  }
});

// Get all posts
app.get('/posts', async (req, res) => {
  try {
    const posts = await Post.find(
      {},
      { _id: 0, __v: 0 }
    ).sort({ publishedAt: -1 });
    res.json(posts);
  } catch (err) {
    console.error('Error fetching posts:', err);
    res.status(500).json([]);
  }
});

// Subscribe endpoint
app.post('/subscribe', async (req, res) => {
  const email = normEmail(req.body.email || '');
  const name = req.body.name || '';

  if (!email.includes('@')) {
    return res.status(400).json({ success: false, message: 'Invalid email' });
  }

  let isNew = false;

  try {
    await Subscriber.create({ email, name });
    isNew = true;
  } catch (err) {
    if (err.code === 11000) {
      // Duplicate email
      return res.json({ success: true, message: 'Already subscribed' });
    }
    console.error('Error creating subscriber:', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }

  if (isNew) {
    const welcomeHtml = `
    <!DOCTYPE html>
    <html>
    <body style="margin:0;background:#f4f6f8;font-family:Arial,sans-serif;">
      <table width="100%" cellpadding="0" cellspacing="0">
        <tr>
          <td align="center" style="padding:30px;">
            <table width="600" style="background:#ffffff;padding:30px;border-radius:6px;">
              <tr>
                <td>
                  <h2 style="color:#222;">Welcome, ${name || 'there'} 👋</h2>
                  <p style="color:#444;font-size:15px;line-height:1.6;">
                    Thanks for subscribing to <strong>${process.env.EMAIL_USER}</strong>.
                  </p>
                  <p style="color:#444;font-size:15px;line-height:1.6;">
                    You'll receive updates whenever we publish something new.
                  </p>
                  <hr style="margin:25px 0;">
                  <p style="font-size:13px;color:#777;">
                    — ${process.env.FROM_NAME}<br>
                    ${process.env.FROM_EMAIL}
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
    `;

    // Send welcome email
    await safeSend({
      from: `"${process.env.FROM_NAME}" <${process.env.FROM_EMAIL}>`,
      to: email,
      subject: 'Welcome to our updates',
      html: welcomeHtml
    });

    // Notify admin
    const adminHtml = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#f4f6f8;padding:20px;">
      <div style="max-width:600px;background:#fff;padding:20px;border-radius:6px;">
        <h3>New Subscriber</h3>
        <p><strong>Email:</strong> ${email}</p>
        <p><strong>Name:</strong> ${name || '-'}</p>
        <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        <p><strong>Total subscribers:</strong> ${await Subscriber.countDocuments()}</p>
      </div>
    </body>
    </html>
    `;

    await safeSend({
      from: process.env.FROM_EMAIL,
      to: process.env.ADMIN_EMAIL,
      subject: 'New Subscriber Joined',
      html: adminHtml
    });
  }

  res.json({ success: true, message: 'Subscribed successfully' });
});

// Publish endpoint
app.post('/publish', upload.single('attachment'), async (req, res) => {
  try {
    // Check secret
    if (req.headers['x-publish-secret'] !== process.env.PUBLISH_SECRET) {
      return res.status(401).json({ success: false, message: 'Invalid secret' });
    }

    const { title, excerpt, postUrl, content, sendFull } = req.body;
    
    if (!title || !postUrl) {
      return res.status(400).json({ success: false, message: 'Title and post URL are required' });
    }

    // Get all subscribers
    const subs = await Subscriber.find({});
    
    // Handle attachment
    let attachmentUrl = null;
    let attachmentName = null;
    
    if (req.file) {
      attachmentUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
      attachmentName = req.file.originalname;
    }

    // Store post in database
    const post = await Post.create({
      title,
      excerpt: excerpt || '',
      content: content || '',
      postUrl,
      attachmentUrl,
      attachmentName,
      sendFull: sendFull === '1',
      publishedAt: new Date()
    });

    // Prepare email content
    const emailBody = sendFull === '1' ? (content || excerpt || '') : (excerpt || '');
    
    // Send emails to all subscribers
    let sentCount = 0;
    
    for (const subscriber of subs) {
      const unsubscribeLink = `${req.protocol}://${req.get('host')}/unsubscribe?email=${encodeURIComponent(subscriber.email)}`;
      
      const publishHtml = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#f5f7fb;font-family:Inter,Segoe UI,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding:32px 16px;">
        <table width="600" cellpadding="0" cellspacing="0"
          style="background:#ffffff;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,0.08);overflow:hidden;">
          
          <!-- Header -->
          <tr>
            <td style="background:#2c3e50;padding:20px 24px;color:#ffffff;">
              <h2 style="margin:0;font-size:20px;">
                ${process.env.FROM_NAME} · New Post
              </h2>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding:24px;color:#222;">
              <h1 style="margin-top:0;font-size:22px;">
                ${title}
              </h1>

              <div style="font-size:15px;line-height:1.7;color:#333;">
                ${emailBody}
              </div>

              ${sendFull !== '1' && excerpt && content ? 
                `<div style="margin:20px 0;padding:15px;background:#f8f9fa;border-radius:8px;">
                  <p style="margin:0;font-style:italic;">Full article available at the link below...</p>
                </div>` : ''
              }

              <p style="margin-top:20px;">
                <a href="${postUrl}"
                   style="display:inline-block;background:#3498db;color:#fff;
                          padding:10px 16px;border-radius:999px;
                          text-decoration:none;font-size:14px;">
                  Read full article →
                </a>
              </p>
              
              ${attachmentUrl ? 
                `<div style="margin-top:20px;padding:15px;background:#f8f9fa;border-radius:8px;">
                  <p style="margin:0 0 10px 0;"><strong>Attachment:</strong></p>
                  <a href="${attachmentUrl}" 
                     style="color:#3498db;text-decoration:none;font-size:14px;">
                    📎 ${attachmentName || 'Download attached file'}
                  </a>
                </div>` : ''
              }
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#fafafa;padding:18px 24px;font-size:12px;color:#777;">
              <p style="margin:0;">
                You are receiving this email because you subscribed to
                <strong>${process.env.FROM_NAME}</strong>.
              </p>
              <p style="margin:6px 0 0 0;">
                <a href="${unsubscribeLink}" style="color:#777;text-decoration:underline;">
                  Unsubscribe
                </a> | 
                © ${new Date().getFullYear()} ${process.env.FROM_NAME}
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
      `;

      const mailOptions = {
        from: `"${process.env.FROM_NAME}" <${process.env.FROM_EMAIL}>`,
        to: subscriber.email,
        subject: title,
        html: publishHtml
      };

      // Add attachment if exists
      if (req.file) {
        mailOptions.attachments = [{
          filename: req.file.originalname,
          path: req.file.path
        }];
      }

      const ok = await safeSend(mailOptions);
      if (ok) sentCount++;
      
      // Small delay between emails to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // Notify admin about publication
    const adminHtml = `
    <!DOCTYPE html>
    <html>
    <body style="font-family:Arial,sans-serif;background:#f4f6f8;padding:20px;">
      <div style="max-width:600px;background:#fff;padding:20px;border-radius:6px;">
        <h3>Post Published Successfully</h3>
        <p><strong>Title:</strong> ${title}</p>
        <p><strong>Sent to:</strong> ${sentCount} subscribers</p>
        <p><strong>Total subscribers:</strong> ${subs.length}</p>
        <p><strong>Time:</strong> ${new Date().toLocaleString()}</p>
        ${attachmentUrl ? `<p><strong>Attachment:</strong> ${attachmentName} (${attachmentUrl})</p>` : ''}
        <p><strong>Post URL:</strong> ${postUrl}</p>
      </div>
    </body>
    </html>
    `;

    await safeSend({
      from: process.env.FROM_EMAIL,
      to: process.env.ADMIN_EMAIL,
      subject: `Post Published: ${title}`,
      html: adminHtml
    });

    res.json({ 
      success: true, 
      sent: { subscribers: sentCount },
      attachmentUrl: attachmentUrl,
      message: `Published successfully to ${sentCount} subscribers`
    });

  } catch (error) {
    console.error('Publish error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Unsubscribe endpoint
app.post('/unsubscribe', async (req, res) => {
  try {
    const email = normEmail(req.body.email || '');
    await Subscriber.deleteOne({ email: email });
    res.json({ success: true, message: 'Unsubscribed successfully' });
  } catch (err) {
    console.error('Unsubscribe error:', err);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// Get unsubscribe page (for email links)
app.get('/unsubscribe', async (req, res) => {
  const email = req.query.email;
  if (!email) {
    return res.send('No email provided');
  }
  
  try {
    await Subscriber.deleteOne({ email: normEmail(email) });
    res.send(`
      <html>
        <body style="font-family: Arial, sans-serif; padding: 40px; text-align: center;">
          <h2>Successfully Unsubscribed</h2>
          <p>You have been unsubscribed from ${process.env.FROM_NAME} newsletters.</p>
          <p>You will no longer receive emails from us.</p>
        </body>
      </html>
    `);
  } catch (err) {
    res.status(500).send('Error processing unsubscribe request');
  }
});


app.get('/', (_, res) => res.json({ ok: true }));

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Upload directory: ${UPLOAD_DIR}`);
});