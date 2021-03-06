import { HistoricalMessage } from './types';
import logger from './logger';

const formatMessageBlock = (
  msg: string,
  attachments: string[] | null | undefined,
  formatchar: string
) => {
  return msg
    .split('\n')
    .map((x) => (x ? formatchar + x + formatchar : x))
    .map((x) => '>' + x)
    .concat(
      attachments?.length
        ? [
            `*Attachments:* ${attachments
              .map((url, i) => `<${url}|Attachment ${i + 1}>`)
              .join(' ')}`,
          ]
        : []
    )
    .join('\n');
};

export function formatMessageHistory(
  messageObjects: HistoricalMessage[],
  userId: string
): string[] {
  logger.info('ENTERING SLACKMESSAGEFORMATTER.formatMessageHistory');
  const formattedMessages = messageObjects.map((messageObject) => {
    const timeSinceEpochSecs = Date.parse(messageObject.timestamp) / 1000;
    // See https://api.slack.com/reference/surfaces/formatting#visual-styles
    const specialSlackTimestamp = `<!date^${timeSinceEpochSecs}^{time} {date_short}|${messageObject.timestamp}>`;
    if (messageObject.direction == 'INBOUND') {
      return (
        `:bust_in_silhouette: *Voter ${userId}*  ` +
        specialSlackTimestamp +
        '\n' +
        formatMessageBlock(
          messageObject.message,
          messageObject.twilio_attachments,
          '*'
        )
      );
    } else if (messageObject.automated) {
      return (
        ':gear: *Helpline (Automated)*  ' +
        specialSlackTimestamp +
        '\n' +
        formatMessageBlock(messageObject.message, [], '_')
      );
    } else {
      return (
        `:adult: *${messageObject.originating_slack_user_name} (Volunteer)*  ` +
        specialSlackTimestamp +
        '\n' +
        formatMessageBlock(
          messageObject.message,
          messageObject.slack_attachments?.map(({ permalink }) => permalink),
          ''
        )
      );
    }
  });

  return formattedMessages;
}

export function paginateMessageHistory(messages: string[]): string[] {
  // group individual messages into pages
  const maxLength = 2000; // slack limit is ~3000; leave room for blocks etc.
  const pages = [] as string[];
  let page = '';
  for (const msg of messages) {
    if (page.length == 0) {
      page = msg;
    } else if (page.length + 2 + msg.length >= maxLength) {
      pages.push(page);
      page = msg;
    } else {
      page += '\n\n' + msg;
    }
  }
  if (page.length) {
    pages.push(page);
  } else {
    pages.push('No history available');
  }
  return pages;
}
