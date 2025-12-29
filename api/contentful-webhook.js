import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

// Helper to parse body - handles string, object, or buffer
function parseBody(req) {
  if (!req.body) return null;
  
  // Already an object
  if (typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  
  // String or Buffer - parse as JSON
  try {
    const str = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body;
    return JSON.parse(str);
  } catch (e) {
    console.error('Failed to parse body:', e);
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = parseBody(req);
    
    console.log('Webhook received:', {
      topic: req.headers['x-contentful-topic'],
      hasBody: !!body,
      bodyKeys: body ? Object.keys(body) : []
    });

    if (!body) {
      console.error('No body received or failed to parse');
      return res.status(400).json({ error: 'No body received' });
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
