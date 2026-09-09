/**
 * Paste this into script.google.com (a new standalone Apps Script project,
 * bound to your Google account). Set up a time-driven trigger to run
 * checkForEnquiries every 5 minutes (Triggers icon in the left sidebar).
 *
 * How it decides what's an "enquiry": any thread in Gmail with the label
 * ENIG-Enquiry that doesn't also have ENIG-Enquiry-Sent. Create a Gmail
 * filter that applies the ENIG-Enquiry label to whatever mail should be
 * treated as an incoming commercial enquiry (e.g. a specific forwarding
 * address, or mail matching certain senders/subjects) — this script never
 * decides that on its own, it only processes what you've already labeled.
 */

const WORKER_URL = 'https://enig-agent.martnkpogo.workers.dev/email/webhook';
const WEBHOOK_SECRET = 'PASTE_YOUR_EMAIL_WEBHOOK_SECRET_HERE';
const LABEL_TO_PROCESS = 'ENIG-Enquiry';
const LABEL_PROCESSED = 'ENIG-Enquiry-Sent';

function checkForEnquiries() {
  const label = GmailApp.getUserLabelByName(LABEL_TO_PROCESS);
  if (!label) {
    console.error(`Label "${LABEL_TO_PROCESS}" doesn't exist yet — create it in Gmail first.`);
    return;
  }
  let processedLabel = GmailApp.getUserLabelByName(LABEL_PROCESSED);
  if (!processedLabel) {
    processedLabel = GmailApp.createLabel(LABEL_PROCESSED);
  }

  const threads = label.getThreads();
  for (const thread of threads) {
    if (thread.getLabels().some((l) => l.getName() === LABEL_PROCESSED)) continue;

    const message = thread.getMessages()[thread.getMessages().length - 1];
    const payload = {
      from: message.getFrom(),
      subject: message.getSubject(),
      text: message.getPlainBody().slice(0, 4000),
    };

    const response = UrlFetchApp.fetch(WORKER_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Email-Webhook-Secret': WEBHOOK_SECRET },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true,
    });

    if (response.getResponseCode() === 200) {
      thread.addLabel(processedLabel);
    } else {
      console.error(`Failed to send enquiry to Worker: ${response.getResponseCode()} ${response.getContentText()}`);
    }
  }
}
