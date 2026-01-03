import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Disable Vercel's body parser so we can read the raw body
export const config = {
  api: {
    bodyParser: false,
  },
};

// Helper to read raw body from request
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      resolve(data);
    });
    req.on('error', (err) => {
      reject(err);
    });
  });
}

async function sendPushNotification(token, project) {
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
    // Read the raw body
    const rawBody = await getRawBody(req);
    
    console.log('Webhook received:', {
      topic: req.headers['x-contentful-topic'],
      rawBodyLength: rawBody?.length || 0,
      rawBodyPreview: rawBody?.substring(0, 200)
    });

    if (!rawBody) {
      console.error('No body received');
      return res.status(400).json({ error: 'No body received' });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      console.error('Failed to parse JSON:', e);
      return res.status(400).json({ error: 'Invalid JSON' });
    }

    const { sys, fields } = body;
    const topic = req.headers['x-contentful-topic'];
    
    // Only process published projects
    if (topic !== 'ContentManagement.Entry.publish' || sys?.contentType?.sys?.id !== 'project') {
      return res.status(200).json({ message: 'Ignored - not a project publish event' });
    }

    // Check if sendNotification field is set to true
    const shouldSendNotification = fields?.sendNotification?.['en-US'] === true;

    if (!shouldSendNotification) {
      console.log('Notification skipped - sendNotification is not enabled for this project');
      return res.status(200).json({ 
        message: 'Project published but notifications not sent (sendNotification is false or not set)',
        projectId: sys?.id,
        projectTitle: fields?.title?.['en-US']
      });
    }

    const project = {
      id: sys.id,
      title: fields?.title?.['en-US'] || 'New Project',
      architect: fields?.architect?.['en-US'] || 'Unknown',
    };

    console.log(`Sending notifications for project: ${project.title}`);

    // Get all users with notifications enabled
    const { data: users, error: userError } = await supabase
      .from('user_push_tokens')
      .select('push_token, user_id')
      .eq('notifications_enabled', true);

    if (userError) {
      console.error('Error fetching users:', userError);
      return res.status(500).json({ error: 'Database error fetching users' });
    }

    let sent = 0;
    let errors = 0;

    for (const user of users || []) {
      try {
        const result = await sendPushNotification(user.push_token, project);
        
        if (result?.data?.status === 'ok') {
          sent++;
          
          // Record notification in history
          await supabase
            .from('notification_history')
            .insert({
              user_id: user.user_id,
              project_id: project.id,
              notified_at: new Date().toISOString(),
            });
        } else {
          errors++;
          console.error(`Failed to send to user ${user.user_id}:`, result);
        }
        
        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch (error) {
        errors++;
        console.error(`Error sending to user ${user.user_id}:`, error);
      }
    }

    console.log(`Notifications sent: ${sent}, errors: ${errors}`);

    return res.status(200).json({ 
      success: true, 
      sent,
      errors,
      projectId: project.id,
      projectTitle: project.title
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}
