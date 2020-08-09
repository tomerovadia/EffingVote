const { Client } = require('pg');

exports.logMessageToDb = (databaseMessageEntry) => {
  console.log('Inserting into database');
  const pgDatabaseClient = new Client({
    connectionString: process.env.DATABASE_URL,
  });

  pgDatabaseClient.connect()
    .then(() => {
      pgDatabaseClient.query("INSERT INTO messages (message, direction, automated, successfully_sent, from_phone_number, user_id, to_phone_number, originating_slack_user_id, slack_channel, slack_parent_message_ts, twilio_message_sid, slack_message_ts, slack_error, twilio_error, twilio_send_timestamp, twilio_receive_timestamp, slack_send_timestamp, slack_receive_timestamp, confirmed_disclaimer, is_demo, last_voter_message_secs_from_epoch) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21);", [
        databaseMessageEntry.message,
        databaseMessageEntry.direction,
        databaseMessageEntry.automated,
        databaseMessageEntry.successfullySent,
        databaseMessageEntry.fromPhoneNumber,
        databaseMessageEntry.userId,
        databaseMessageEntry.toPhoneNumber,
        databaseMessageEntry.originatingSlackUserId,
        databaseMessageEntry.slackChannel,
        databaseMessageEntry.slackParentMessageTs,
        databaseMessageEntry.twilioMessageSid,
        databaseMessageEntry.slackMessageTs,
        databaseMessageEntry.slackError,
        databaseMessageEntry.twilioError,
        databaseMessageEntry.twilioSendTimestamp,
        databaseMessageEntry.twilioReceiveTimestamp,
        databaseMessageEntry.slackSendTimestamp,
        databaseMessageEntry.slackReceiveTimestamp,
        databaseMessageEntry.confirmedDisclaimer,
        databaseMessageEntry.isDemo,
        databaseMessageEntry.lastVoterMessageSecsFromEpoch
      ], (err, res) => {
        if (err) {
          console.log("Error from PostgreSQL database insert", err);
        } else {
          console.log("No error from PostgreSQL database insert");
        }
        pgDatabaseClient.end();
      });
    })
    .catch(err => console.error('PostgreSQL database connection error', err.stack));
};

// Populates immediately available info into the DB entry upon receiving a message from Twilio.
exports.populateIncomingDbMessageTwilioEntry = ({userMessage, userPhoneNumber, twilioPhoneNumber, twilioMessageSid}) => {
  return {
    message: userMessage,
    direction: "INBOUND",
    automated: null,
    // To be updated later
    successfullySent: false,
    fromPhoneNumber: userPhoneNumber,
    toPhoneNumber: twilioPhoneNumber,
    originatingSlackUserId: null,

    // To be filled later
    slackChannel: null,
    // To be filled later
    slackParentMessageTs: null,

    twilioMessageSid,
    // To be filled later
    slackMessageTs: null,
    // To be maybe filled later
    slackError: null,
    twilioError: null,

    twilioSendTimestamp: null,
    twilioReceiveTimestamp: new Date(),
    // To be filled later
    slackSendTimestamp: null,
    slackReceiveTimestamp: null,

    // Note: These are userInfo fields. Keep these null so that their only set is right before sending, so that the actual values are ensured to be logged.
    // To be filled later
    userId: null,
    // To be filled later
    confirmedDisclaimer: null,
    // To be filled later
    isDemo: null,
    // To be filled later
    lastVoterMessageSecsFromEpoch: null,
  };
};

// Populates immediately available info into the DB entry upon receiving a message from Slack.
exports.populateIncomingDbMessageSlackEntry = ({originatingSlackUserId, slackChannel, slackParentMessageTs, slackMessageTs}) => {
  return {
    direction: "OUTBOUND",
    automated: false,

    // To be filled later
    successfullySent: null,
    // To be filled later
    fromPhoneNumber: null,
    // To be filled later
    toPhoneNumber: null,
    originatingSlackUserId,

    slackChannel,
    slackParentMessageTs,

    // To be filled later
    twilioMessageSid: null,
    slackMessageTs,
    slackError: null,

    // To be filled later
    twilioSendTimestamp: null,
    twilioReceiveTimestamp: null,
    slackSendTimestamp: null,
    slackReceiveTimestamp: new Date(),

    // Note: These are userInfo fields. Keep these null so that their only set is right before sending, so that the actual values are ensured to be logged.
    // To be filled later
    userId: null,
    // To be filled later
    confirmedDisclaimer: null,
    // To be filled later
    isDemo: null,
    // To be filled later
    lastVoterMessageSecsFromEpoch: null,
  };
};

// Updates an incoming DB entry right before it is sent with information from the userInfo.
exports.updateDbMessageEntryWithUserInfo = (userInfo, dbMessageEntry) => {
  dbMessageEntry.userId = userInfo.userId;
  dbMessageEntry.confirmedDisclaimer = userInfo.confirmedDisclaimer;
  dbMessageEntry.isDemo = userInfo.isDemo;
  dbMessageEntry.lastVoterMessageSecsFromEpoch = userInfo.lastVoterMessageSecsFromEpoch;
};

// Populates a DB entry with available info right before it is passed to TwilioApiUtil for additional info and writing to DB.
exports.populateAutomatedDbMessageEntry = (userInfo) => {
  return {
    message: null,
    direction: "OUTBOUND",
    automated: true,

    // To be filled later
    successfullySent: null,
    // To be filled later
    fromPhoneNumber: null,
    // To be filled later
    toPhoneNumber: null,
    originatingSlackUserId: null,

    // Since this message doesn't originate from and isn't intended for Slack,
    // these are considered irrelevant.
    slackChannel: null,
    slackParentMessageTs: null,

    // To be filled later
    twilioMessageSid: null,
    // Since this message doesn't originate from and isn't intended for Slack,
    // these are considered irrelevant.
    slackMessageTs: null,
    slackError: null,

    // To be filled later
    twilioSendTimestamp: null,
    twilioReceiveTimestamp: null,
    slackSendTimestamp: null,
    slackReceiveTimestamp: null,

    userId: userInfo.userId,
    confirmedDisclaimer: userInfo.confirmedDisclaimer,
    isDemo: userInfo.isDemo,
    lastVoterMessageSecsFromEpoch: userInfo.lastVoterMessageSecsFromEpoch,
  };
};