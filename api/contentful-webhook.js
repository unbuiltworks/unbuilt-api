import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Disable automatic body parsing - we'll do it manually
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper function to read the raw body
async function getRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function sendNotification(token, project) {
  const message = {
    to: token,
    sound: 'default',
    title: 'New Project Published',
    body: `${project.title} by ${project.architect}`,
    data: { 
      projectId: project.id,
      screen: 'daily',
    },
    badge: 1,
  };

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(message),
  });

  return response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Manually parse the body
    const rawBody = await getRawBody(req);
    const body = JSON.parse(rawBody);
    
    console.log('Webhook received successfully!');
    console.log('Parsed body:', body);

    const { sys, fields } = body;
    const topic = req.headers['x-contentful-topic'];
    
    // Only process published projects
    if (topic !== 'ContentManagement.Entry.publish' || sys?.contentType?.sys?.id !== 'project') {
      return res.status(200).json({ message: 'Ignored', topic, contentType: sys?.contentType?.sys?.id });
    }

    const project = {
      id: sys.id,
      title: fields.title?.['en-US'] || 'New Project',
      architect: fields.architect?.['en-US'] || 'Unknown',
    };

    console.log('Processing project:', project);

    // Get all users with notifications enabled
    const { data: users, error: dbError } = await supabase
      .from('user_push_tokens')
      .select('push_token');

    if (dbError) {
      console.error('Database error:', dbError);
      return res.status(500).json({ error: 'Database error', details: dbError.message });
    }

    let sent = 0;
    for (const user of users || []) {
      await sendNotification(user.push_token, project);
      sent++;
    }

    console.log(`Sent ${sent} notifications`);
    return res.status(200).json({ success: true, sent, project: project.title });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}
