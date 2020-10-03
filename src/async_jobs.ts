/**
 * Slack requires that you respond to webhooks within 3 seconds. So when
 * responding to Slack webhooks, we kick off a background job and then respond
 * immediately with a 200.
 *
 * How we run background tasks depends on how we're deployed. By default, we
 * just run the task in the background. On Lambda, we instead invoke the
 * worker Lambda function (which runs this same codebase) asynchronously.
 */
import * as Sentry from '@sentry/node';

import * as SlackApiUtil from './slack_api_util';
import * as RedisApiUtil from './redis_api_util';
import * as SlackInteractionHandler from './slack_interaction_handler';
import * as Router from './router';
import logger from './logger';
import redisClient from './redis_client';

import { SlackEventPayload } from './slack_interaction_handler';
import { wrapLambdaHandlerForSentry } from './sentry_wrapper';
import { SlackEventRequestBody } from './router';
import { UserInfo } from './types';

async function slackInteractivityHandler(payload: SlackEventPayload) {
  const originatingSlackUserName = await SlackApiUtil.fetchSlackUserName(
    payload.user.id
  );
  if (!originatingSlackUserName) {
    throw new Error(
      `Could not get slack user name for slack user ${payload.user.id}`
    );
  }

  const originatingSlackChannelName = await SlackApiUtil.fetchSlackChannelName(
    payload.channel.id
  );
  if (!originatingSlackChannelName) {
    throw new Error(
      `Could not get slack channel name for Slack channel ${payload.channel.id}`
    );
  }

  const redisHashKey = `${payload.channel.id}:${payload.container.thread_ts}`;
  const redisData = await RedisApiUtil.getHash(redisClient, redisHashKey);

  const selectedVoterStatus = payload.actions[0].selected_option
    ? payload.actions[0].selected_option.value
    : payload.actions[0].value;
  if (selectedVoterStatus) {
    logger.info(
      `SERVER POST /slack-interactivity: Determined user interaction is a voter status update or undo.`
    );
    await SlackInteractionHandler.handleVoterStatusUpdate({
      payload,
      selectedVoterStatus,
      originatingSlackUserName,
      slackChannelName: originatingSlackChannelName,
      userPhoneNumber: redisData.userPhoneNumber,
      twilioPhoneNumber: redisData.twilioPhoneNumber,
      redisClient,
    });
  } else if (payload.actions[0].selected_user) {
    logger.info(
      `SERVER POST /slack-interactivity: Determined user interaction is a volunteer update.`
    );
    await SlackInteractionHandler.handleVolunteerUpdate({
      payload,
      originatingSlackUserName,
      slackChannelName: originatingSlackChannelName,
      userPhoneNumber: redisData.userPhoneNumber,
      twilioPhoneNumber: redisData.twilioPhoneNumber,
    });
  }
}

async function slackMessageEventHandler(
  reqBody: SlackEventRequestBody,
  {
    retryCount,
    retryReason,
  }: { retryCount: number | undefined; retryReason: string | undefined }
) {
  logger.info(
    `SERVER POST /slack: Slack event listener caught non-bot Slack message from ${reqBody.event.user}.`
  );
  const redisHashKey = `${reqBody.event.channel}:${reqBody.event.thread_ts}`;

  // Pass Slack message to Twilio
  const redisData = (await RedisApiUtil.getHash(
    redisClient,
    redisHashKey
  )) as UserInfo;

  if (redisData != null) {
    logger.info(
      'SERVER POST /slack: Server received non-bot Slack message INSIDE a voter thread.'
    );

    const outboundTextsBlocked = await RedisApiUtil.getHashField(
      redisClient,
      'slackBlockedUserPhoneNumbers',
      redisData.userPhoneNumber
    );
    if (outboundTextsBlocked != '1') {
      const originatingSlackUserName = await SlackApiUtil.fetchSlackUserName(
        reqBody.event.user
      );
      if (!originatingSlackUserName) {
        throw new Error(
          `Could not get slack user name for slack user ${reqBody.event.user}`
        );
      }

      logger.info(
        `SERVER POST /slack: Successfully determined Slack user name of message sender: ${originatingSlackUserName}, from Slack user ID: ${reqBody.event.user}`
      );
      await Router.handleSlackVoterThreadMessage(
        reqBody,
        redisClient,
        redisData,
        originatingSlackUserName,
        { retryCount, retryReason }
      );
    } else {
      logger.info(
        `SERVER POST /slack: Received attempted Slack message to blocked phone number: ${redisData.userPhoneNumber}`
      );
      await SlackApiUtil.sendMessage(
        `*Operator:* Your message was not relayed, as this phone number has been added to our blocklist.`,
        {
          channel: reqBody.event.channel,
          parentMessageTs: reqBody.event.thread_ts,
        }
      );
    }
  } else {
    // Hash doesn't exist (this message is likely outside of a voter thread).
    logger.info(
      'SERVER POST /slack: Server received non-bot Slack message OUTSIDE a voter thread. Doing nothing.'
    );
  }
}

async function slackAppMentionEventHandler(reqBody: SlackEventRequestBody) {
  const originatingSlackUserName = await SlackApiUtil.fetchSlackUserName(
    reqBody.event.user
  );
  if (!originatingSlackUserName) {
    throw new Error(
      `Could not get slack user name for slack user ${reqBody.event.user}`
    );
  }
  logger.info(
    `SERVER POST /slack: Successfully determined Slack user name of bot mentioner: ${originatingSlackUserName}, from Slack user ID: ${reqBody.event.user}`
  );
  // For these commands, require that the message was sent in the #admin-control-room Slack channel.
  if (
    reqBody.event.channel === process.env.ADMIN_CONTROL_ROOM_SLACK_CHANNEL_ID
  ) {
    logger.info(
      'SERVER POST /slack: Slack event listener caught bot mention in admin channel.'
    );
    logger.info(
      `SERVER POST /slack: Received admin control command from ${originatingSlackUserName}: ${reqBody.event.text}`
    );
    await Router.handleSlackAdminCommand(
      reqBody,
      redisClient,
      originatingSlackUserName
    );
  }
}

const BACKGROUND_TASKS = {
  slackInteractivityHandler,
  slackMessageEventHandler,
  slackAppMentionEventHandler,
};

export async function enqueueBackgroundTask(
  // These type declarations are a bit complicated -- basically, this is saying
  // that `taskName` must be one of the keys of BACKGROUND_TASKS, and that
  // `args` must match the arguments of that function
  taskName: keyof typeof BACKGROUND_TASKS,
  ...args: Parameters<typeof BACKGROUND_TASKS[typeof taskName]>
): Promise<void> {
  if (process.env.LAMBDA_BACKGROUND_TASK_FUNCTION) {
    // We require and instantiate the lambda client here rather than
    // at the top of the file so that we don't require aws-sdk in non-lambda
    // environment -- it's a very large library and it's included by default
    // in the Lambda environment so we don't need to declare it as a
    // dependency

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const AWS = require('aws-sdk');
    const lambda = new AWS.Lambda();

    // use an async lambda invocation to run the background task
    logger.info(
      `Running background task ${taskName} via async lambda invocation`
    );
    const result = await lambda
      .invoke({
        FunctionName: process.env.LAMBDA_BACKGROUND_TASK_FUNCTION,
        Payload: JSON.stringify({
          taskName,
          args,
        }),
        InvocationType: 'Event',
      })
      .promise();
    logger.info(`Invoke result: ${result.StatusCode}`);
  } else {
    // just run the function, but don't await the promise so we don't block
    // on completion
    logger.info(`Running background task ${taskName} as a background promise`);

    // @ts-ignore Typescript can't follow this kind of dynamic function call
    BACKGROUND_TASKS[taskName](...args).catch((err) => {
      logger.error(err);
      Sentry.captureException(err);
    });
  }
}

export const backgroundLambdaHandler = wrapLambdaHandlerForSentry(
  async (event: any): Promise<void> => {
    logger.info(
      `Running Lambda background function with payload: ${JSON.stringify(
        event
      )}`
    );

    const { taskName, args } = event;

    if (!(taskName in BACKGROUND_TASKS)) {
      throw new Error(`Got an invalid task name: ${taskName}`);
    }

    // @ts-ignore Typescript can't check this -- everything's coming in from the
    // dynamic payload
    await BACKGROUND_TASKS[taskName](...args);
  }
);
