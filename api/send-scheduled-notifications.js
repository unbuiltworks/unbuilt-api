import { createClient } from '@supabase/supabase-js';
import { createClient as createContentfulClient } from 'contentful';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const contentful = createContentfulClient({
  space: process.env.CONTENTFUL_SPACE_ID,
  accessToken: process.env.CONTENTFUL_ACCESS_TOKEN,
});

// Disable body parser for cron jobs
export const config = {
  api: {
    bodyParser: false,
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

async function getRecentProjects(sinceDate) {
  try {
    // Get projects published in the last 24 hours
    const response = await contentful.getEntries({
      content_type: 'project',
      'sys.createdAt[gte]': sinceDate,
      order: '-sys.createdAt',
    });

    return response.items.map(item => ({
      id: item.sys.id,
      title: item.fields.title || 'Untitled Project',
      architect: item.fields.architect || 'Unknown Architect',
      publishedAt: item.sys.createdAt,
    }));
  } catch (error) {
    console.error('Error fetching projects from Contentful:', error);
    return [];
  }
}

export default async function handler(req, res) {
  // Verify this is a cron request (optional but recommended)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    console.log('🕐 Cron job started at:', new Date().toISOString());

    // Get current hour and minute
    const now = new Date();
    const currentHour = now.getUTCHours(); // Use UTC for consistency
    const currentMinute = now.getUTCMinutes();

    console.log(`Current time: ${currentHour}:${currentMinute} UTC`);

    // Get recent projects (published in last 24 hours)
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const recentProjects = await getRecentProjects(oneDayAgo);

    console.log(`Found ${recentProjects.length} recent projects`);

    if (recentProjects.length === 0) {
      return res.status(200).json({ 
        message: 'No new projects to notify about',
        time: `${currentHour}:${currentMinute}` 
      });
    }

    // Get users who want notifications at this hour
    // Note: You'll need to convert their local time preference to UTC
    const { data: users, error: userError } = await supabase
      .from('user_push_tokens')
      .select('user_id, push_token, notification_hour, notification_minute')
      .eq('notifications_enabled', true)
      .eq('notification_hour', currentHour)
      .gte('notification_minute', currentMinute - 5) // 5 min window
      .lte('notification_minute', currentMinute + 5);

    if (userError) {
      console.error('Error fetching users:', userError);
      return res.status(500).json({ error: 'Database error' });
    }

    console.log(`Found ${users?.length || 0} users scheduled for this time`);

    if (!users || users.length === 0) {
      return res.status(200).json({ 
        message: 'No users scheduled for notifications at this time',
        time: `${currentHour}:${currentMinute}`,
        projectsAvailable: recentProjects.length
      });
    }

    let notificationsSent = 0;
    let errors = 0;

    // Send notifications to each user
    for (const user of users) {
      try {
        // Check which projects this user hasn't been notified about
        const { data: notifiedProjects } = await supabase
          .from('notification_history')
          .select('project_id')
          .eq('user_id', user.user_id)
          .in('project_id', recentProjects.map(p => p.id));

        const notifiedProjectIds = new Set(
          notifiedProjects?.map(n => n.project_id) || []
        );

        // Filter to only new projects for this user
        const newProjects = recentProjects.filter(
          p => !notifiedProjectIds.has(p.id)
        );

        if (newProjects.length === 0) {
          console.log(`User ${user.user_id} already notified of all projects`);
          continue;
        }

        // Send notification for the most recent project
        const project = newProjects[0];
        const result = await sendNotification(user.push_token, project);

        if (result && result.data && result.data.status === 'ok') {
          // Record that we notified this user about this project
          await supabase
            .from('notification_history')
            .insert({
              user_id: user.user_id,
              project_id: project.id,
              notified_at: new Date().toISOString(),
            });

          notificationsSent++;
          console.log(`✅ Sent notification to user ${user.user_id} about "${project.title}"`);
        } else {
          errors++;
          console.error(`Failed to send to user ${user.user_id}:`, result);
        }

        // Small delay to avoid rate limiting
        await new Promise(resolve => setTimeout(resolve, 100));

      } catch (error) {
        errors++;
        console.error(`Error processing user ${user.user_id}:`, error);
      }
    }

    return res.status(200).json({ 
      success: true,
      time: `${currentHour}:${currentMinute} UTC`,
      projectsAvailable: recentProjects.length,
      usersScheduled: users.length,
      notificationsSent,
      errors
    });

  } catch (error) {
    console.error('Cron job error:', error);
    return res.status(500).json({ error: error.message });
  }
}
