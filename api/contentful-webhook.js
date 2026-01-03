import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function sendPushNotification(token, caseFile) {
  const message = {
    to: token,
    sound: 'default',
    title: '🗃 NEW CASE FILE DECLASSIFIED',
    body: `${caseFile.title}`,
    data: { 
      caseId: caseFile.id,
      screen: 'case',
    },
    badge: 1,
    categoryId: 'new_case',
  };

  try {
    const response = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(message),
    });

    const result = await response.json();
    return result;
  } catch (error) {
    console.error('Error sending push notification:', error);
    return null;
  }
}

// Helper to parse body - handles both pre-parsed and raw body
async function parseBody(req) {
  // If body is already parsed
  if (req.body && typeof req.body === 'object' && Object.keys(req.body).length > 0) {
    return req.body;
  }
  
  // Try to read raw body
  try {
    const chunks = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const rawBody = Buffer.concat(chunks).toString('utf8');
    
    if (rawBody) {
      return JSON.parse(rawBody);
    }
  } catch (e) {
    console.log('Could not parse raw body:', e.message);
  }
  
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // Parse body with fallback
    const body = await parseBody(req);
    
    console.log('[Webhook] Received:', {
      topic: req.headers['x-contentful-topic'],
      hasBody: !!body,
      contentType: body?.sys?.contentType?.sys?.id,
    });

    if (!body) {
      console.error('No body received');
      return res.status(400).json({ error: 'No body received' });
    }

    const { sys, fields } = body;
    const topic = req.headers['x-contentful-topic'];
    
    // Only process published case files
    if (topic !== 'ContentManagement.Entry.publish') {
      return res.status(200).json({ message: 'Not a publish event, ignored' });
    }
    
    if (!sys) {
      console.error('No sys object in body');
      return res.status(400).json({ error: 'Invalid payload - no sys object' });
    }
    
    // Check for caseFile content type (redactedFileEntry in Contentful)
    const contentType = sys?.contentType?.sys?.id;
    if (contentType !== 'redactedFileEntry') {
      return res.status(200).json({ message: `Content type "${contentType}" ignored, only redactedFileEntry triggers notifications` });
    }

    // Check if sendNotification is enabled (default: false)
    const sendNotification = fields?.sendNotification?.['en-US'] === true;
    if (!sendNotification) {
      console.log('[Webhook] sendNotification is false, skipping notifications');
      return res.status(200).json({ 
        success: true, 
        skipped: true,
        reason: 'sendNotification checkbox is not checked' 
      });
    }

    // Extract case file data - use fileCategory for notification matching
    // fileCategory can be a single value or an array in Contentful
    const rawFileCategory = fields?.fileCategory?.['en-US'];
    const fileCategory = Array.isArray(rawFileCategory) 
      ? rawFileCategory 
      : (rawFileCategory ? [rawFileCategory] : []);
    
    const caseFile = {
      id: sys.id,
      title: fields?.title?.['en-US'] || 'New Case File',
      caseIdNumber: fields?.caseIdNumber?.['en-US'] || fields?.caseIDNumber?.['en-US'] || 0,
      fileCategory: fileCategory,
      slug: fields?.slug?.['en-US'] || sys.id,
    };

    const formattedCaseId = `PU-${String(caseFile.caseIdNumber).padStart(4, '0')}`;
    console.log(`[Webhook] New case file: ${formattedCaseId} - ${caseFile.title}`);
    console.log(`[Webhook] File categories: ${JSON.stringify(caseFile.fileCategory)}`);

    // Get all users with notifications enabled
    const { data: users, error: userError } = await supabase
      .from('user_push_tokens')
      .select('user_id, push_token, notification_case_types')
      .eq('notifications_enabled', true);

    if (userError) {
      console.error('Error fetching users:', userError);
      return res.status(500).json({ error: 'Database error fetching users' });
    }

    if (!users || users.length === 0) {
      console.log('No users with notifications enabled');
      return res.status(200).json({ 
        success: true, 
        message: 'No users to notify',
        caseFile: formattedCaseId,
      });
    }

    console.log(`[Webhook] Processing ${users.length} users...`);

    let sent = 0;
    let skipped = 0;
    let errors = 0;

    for (const user of users) {
      try {
        // Filter by case type preferences (if user has set them)
        // If notification_case_types is null/empty, send to everyone
        // If it's set, only send if case matches user's preferred types
        const userPreferredTypes = user.notification_case_types;
        
        if (userPreferredTypes && Array.isArray(userPreferredTypes) && userPreferredTypes.length > 0) {
          // User has type preferences - check if this case's fileCategory matches
          const hasMatchingType = caseFile.fileCategory.some(category => 
            userPreferredTypes.includes(category)
          );
          
          console.log(`[Webhook] User ${user.user_id}: prefers [${userPreferredTypes.join(', ')}], case has [${caseFile.fileCategory.join(', ')}], match: ${hasMatchingType}`);
          
          if (!hasMatchingType) {
            console.log(`[Webhook] Skipping user ${user.user_id} - no matching categories`);
            skipped++;
            continue;
          }
        }

        const result = await sendPushNotification(user.push_token, caseFile);
        
        if (result && result.data) {
          sent++;
          console.log(`[Webhook] Sent to user ${user.user_id}`);
        } else {
          errors++;
          console.error(`[Webhook] Failed for user ${user.user_id}:`, result);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 50));

      } catch (error) {
        errors++;
        console.error(`Error processing user ${user.user_id}:`, error);
      }
    }

    console.log(`[Webhook] Summary: ${sent} sent, ${skipped} skipped, ${errors} errors`);

    return res.status(200).json({ 
      success: true, 
      caseFile: formattedCaseId,
      title: caseFile.title,
      fileCategory: caseFile.fileCategory,
      totalUsers: users.length,
      sent,
      skipped,
      errors,
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}

// Disable Vercel's default body parser so we can handle it ourselves
export const config = {
  api: {
    bodyParser: false,
  },
};
