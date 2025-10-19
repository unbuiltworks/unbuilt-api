export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const rawBody = await getRawBody(req);
    const body = JSON.parse(rawBody);
    
    console.log('Webhook received - new project published');

    const { sys, fields } = body;
    const topic = req.headers['x-contentful-topic'];
    
    // Only process published projects
    if (topic !== 'ContentManagement.Entry.publish' || sys?.contentType?.sys?.id !== 'project') {
      return res.status(200).json({ message: 'Ignored' });
    }

    const project = {
      id: sys.id,
      title: fields.title?.['en-US'] || 'New Project',
      architect: fields.architect?.['en-US'] || 'Unknown',
      publishedAt: new Date().toISOString()
    };

    console.log('New project ready for notifications:', project);

    // Just return success - don't send notifications yet!
    // The cron job will handle sending at user-preferred times
    return res.status(200).json({ 
      success: true, 
      message: 'Project logged, notifications will be sent at scheduled times',
      project: project.title 
    });
  } catch (error) {
    console.error('Webhook error:', error);
    return res.status(500).json({ error: error.message });
  }
}
