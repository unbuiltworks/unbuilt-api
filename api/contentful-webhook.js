import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ✅ ADD THIS - tells Vercel to parse the request body
export const config = {
  api: {
    bodyParser: true,
  },
};

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
    // ✅ ADD THIS - log to help debug
    console.log('Webhook received:', {
      topic: req.headers['x-contentful-topic'],
      body: req.body
    });

    const { sys, fields } = req.body;
    const topic = req.headers['x-contentful-topic'];
    
    // Only process published projects
    if (topic !== 'ContentManagement.Entry.publish' || sys?.contentType?.sys?.id !== 'project') {
      return res.status(200).json({ message: 'Ignored' });
    }

    const project = {
      id: sys.id,
      title: fields.title?.['en-US'] || 'New Project',
      architect: fields.architect?.['en-US'] || 'Unknown',
    };

    // Get all users with notifications enabled
    const { data: users } = await supabase
      .from('user_push_tokens')
      .select('push_token');

    let sent = 0;
    for (const user of users || []) {
      await sendNotification(user.push_token, project);
      sent++;
    }

    return res.status(200).json({ success: true, sent });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}
