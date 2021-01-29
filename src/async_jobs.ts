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
import Hashes from 'jshashes';
import * as DbApiUtil from './db_api_util';
import * as SlackBlockUtil from './slack_block_util';
import { cloneDeep } from 'lodash';
import * as LoadBalancer from './load_balancer';

import {
  SlackInteractionEventPayload,
  SlackModalPrivateMetadata,
} from './slack_interaction_handler';
import { wrapLambdaHandlerForSentry } from './sentry_wrapper';
import { SlackEventRequestBody } from './router';
import { UserInfo } from './types';
import { SlackActionId, SlackCallbackId } from './slack_interaction_ids';

export type InteractivityHandlerMetadata = { viewId?: string };

async function slackCommandHandler(
  channelId: string,
  channelName: string,
  userId: string,
  userName: string,
  command: string,
  text: string,
  responseUrl: string
) {
  logger.info(`channel ${channelId} command ${command} text ${text}`);
  switch (command) {
    case '/unclaimed': {
      await SlackInteractionHandler.handleCommandUnclaimed(
        channelId,
        channelName,
        userId,
        text,
        responseUrl
      );
      return;
    }
    case '/needs-attention': {
      await SlackInteractionHandler.handleCommandNeedsAttention(
        channelId,
        channelName,
        userId,
        userName,
        text,
        responseUrl
      );
      return;
    }
    case '/broadcast': {
      await SlackInteractionHandler.handleCommandBroadcast(
        channelId,
        channelName,
        userId,
        userName,
        text,
        responseUrl
      );
      return;
    }
    case '/follow-up': {
      await SlackInteractionHandler.handleCommandFollowUp(
        channelId,
        channelName,
        userId,
        userName,
        text,
        responseUrl
      );
      return;
    }
  }
  throw new Error(`Unrecognized command ${command}`);
}

async function slackInteractivityHandler(
  payload: SlackInteractionEventPayload,
  interactivityMetadata: InteractivityHandlerMetadata
) {
  const MD5 = new Hashes.MD5();

  const originatingSlackUserName = await SlackApiUtil.fetchSlackUserName(
    payload.user.id
  );
  if (!originatingSlackUserName) {
    throw new Error(
      `Could not get slack user name for slack user ${payload.user.id}`
    );
  }

  // ignore all actions on inactive threads (archived, re-routed, or old session)
  const thread_ts = payload.message?.thread_ts || payload.message?.ts;
  if (
    thread_ts &&
    !(await DbApiUtil.isActiveSessionThread(thread_ts, payload.channel.id))
  ) {
    logger.info('slackInteractivityHandler: ignoring event on inactive thread');
    await SlackApiUtil.addSlackMessageReaction(
      payload.channel.id,
      thread_ts,
      'zombie'
    );
    return;
  }

  // Global shortcut
  if (payload.type === 'shortcut') {
    // Technically it's possible to have a shortcut that doesn't open a global but all of ours
    // do at the moment, so check for it.
    const { viewId } = interactivityMetadata;
    if (!viewId) {
      throw new Error(
        'slackInteractivityHandler called for message_action without viewId'
      );
    }

    switch (payload.callback_id) {
      case SlackCallbackId.MANAGE_ENTRY_POINTS: {
        logger.info(
          `SERVER POST /slack-interactivity: Determined user interaction is a MANAGE_ENTRY_POINTS_MODAL submission.`
        );

        // This shortcut is called infrequently enough that we can update this cache
        // (and call `conversations.list`) every time the shortcut is called. If this
        // proves to be an issue, we can require an explicit action from the user to
        // update or do something around Slack events for channel creation.
        await SlackApiUtil.updateSlackChannelNamesAndIdsInRedis(redisClient);

        await SlackInteractionHandler.handleManageEntryPoints({
          payload,
          redisClient,
          originatingSlackUserName,
          viewId,
        });
        return;
      }
    }
    throw new Error(`Unrecognized shortcut ${payload.callback_id}`);
  }

  // Message shortcut
  if (payload.type === 'message_action') {
    const originatingSlackChannelName = await SlackApiUtil.fetchSlackChannelName(
      payload.channel.id
    );

    const redisHashKey = `${payload.channel.id}:${payload.message.ts}`;
    const redisData = await RedisApiUtil.getHash(redisClient, redisHashKey);

    logger.info(
      `SERVER POST /slack-interactivity: Determined user interaction is a message shortcut.`
    );

    switch (payload.callback_id) {
      case SlackCallbackId.SET_NEEDS_ATTENTION: {
        // Use thread if message is threaded; original channel msg if there is no thread yet
        await DbApiUtil.setThreadNeedsAttentionToDb(
          payload.message.thread_ts || payload.message.ts,
          payload.channel.id,
          true
        );
        await SlackApiUtil.sendMessage(
          `*Operator:* Thread marked as *Needs Attention* by ${originatingSlackUserName}`,
          {
            parentMessageTs: payload.message.thread_ts || payload.message.ts,
            channel: payload.channel.id,
          }
        );
        return;
      }

      case SlackCallbackId.CLEAR_NEEDS_ATTENTION: {
        // Use thread if message is threaded; original channel msg if there is no thread yet
        await DbApiUtil.setThreadNeedsAttentionToDb(
          payload.message.thread_ts || payload.message.ts,
          payload.channel.id,
          false
        );
        await SlackApiUtil.sendMessage(
          `*Operator:* *Needs Attention* cleared by ${originatingSlackUserName}`,
          {
            parentMessageTs: payload.message.thread_ts || payload.message.ts,
            channel: payload.channel.id,
          }
        );
        return;
      }

      case SlackCallbackId.REVEAL_IDENTITY: {
        if (payload.message.thread_ts) {
          const isAdmin = await SlackApiUtil.isMemberOfAdminChannel(
            payload.user.id
          );
          if (!isAdmin) {
            await SlackApiUtil.sendEphemeralMessage(
              `You must be an admin to use this command`,
              {
                user: payload.user.id,
                channel: payload.channel.id,
                parentMessageTs: payload.message.thread_ts,
              }
            );
            return;
          }
          const userId = MD5.hex(redisData.userPhoneNumber);
          const redisUserInfoKey = `${userId}:${redisData.twilioPhoneNumber}`;
          const userInfo = (await RedisApiUtil.getHash(
            redisClient,
            redisUserInfoKey
          )) as UserInfo;
          await SlackApiUtil.sendEphemeralMessage(
            `*User phone number:* ${userInfo.userPhoneNumber}`,
            {
              user: payload.user.id,
              channel: payload.channel.id,
              parentMessageTs: payload.message.thread_ts,
            }
          );
        } else {
          logger.warn(
            `SERVER POST /slack-interactivity: message shortcut reveal_identity without thread`
          );
        }
        return;
      }

      case SlackCallbackId.RESET_DEMO: {
        const { viewId } = interactivityMetadata;
        if (!viewId) {
          throw new Error(
            'slackInteractivityHandler called for message_action without viewId'
          );
        }

        // Ignore Prettier formatting because this object needs to adhere to JSON strigify requirements.
        // prettier-ignore
        const modalPrivateMetadata = {
          "commandType": 'RESET_DEMO',
          "userId": redisData ? MD5.hex(redisData.userPhoneNumber) : null,
          "userPhoneNumber": redisData ? redisData.userPhoneNumber : null,
          "twilioPhoneNumber": redisData ? redisData.twilioPhoneNumber : null,
          "slackChannelId": payload.channel.id,
          "slackParentMessageTs": payload.message.ts,
          "originatingSlackUserName": originatingSlackUserName,
          "originatingSlackUserId": payload.user.id,
          "slackChannelName": originatingSlackChannelName,
          "actionTs": payload.action_ts
        } as SlackModalPrivateMetadata;

        if (!originatingSlackChannelName || !redisData) {
          modalPrivateMetadata.success = false;
          modalPrivateMetadata.failureReason = 'invalid_shortcut_use';
          await DbApiUtil.logCommandToDb(modalPrivateMetadata);
          const slackView = SlackBlockUtil.getErrorSlackView(
            'not_active_voter_parent_thread',
            'This shortcut is not valid on this message.'
          );
          await SlackApiUtil.updateModal(viewId, slackView);
          logger.info(
            `ASYNCJOBS.slackInteractivityHandler: Volunteer used a reset demo shortcut on an invalid message.`
          );
          return;
        }

        await SlackInteractionHandler.receiveResetDemo({
          payload,
          redisClient,
          modalPrivateMetadata,
          twilioPhoneNumber: redisData.twilioPhoneNumber,
          userId: MD5.hex(redisData.userPhoneNumber),
          viewId,
        });
        return;
      }

      case SlackCallbackId.ROUTE_TO_JOURNEY: {
        const { viewId } = interactivityMetadata;
        if (!viewId) {
          throw new Error(
            'slackInteractivityHandler called for message_action without viewId'
          );
        }

        // Ignore Prettier formatting because this object needs to adhere to JSON strigify requirements.
        // prettier-ignore
        const modalPrivateMetadata = {
          "commandType": 'ROUTE_TO_JOURNEY',
          "userId": redisData ? MD5.hex(redisData.userPhoneNumber) : null,
          "twilioPhoneNumber": redisData ? redisData.twilioPhoneNumber : null,
          "originatingSlackUserName": originatingSlackUserName,
          "originatingSlackUserId": payload.user.id,
          "slackChannelId": payload.channel.id,
          "slackParentMessageTs": thread_ts,
          // destinationSlackChannelName is populated later
        } as SlackModalPrivateMetadata;

        if (!originatingSlackChannelName || !redisData) {
          modalPrivateMetadata.success = false;
          modalPrivateMetadata.failureReason = 'invalid_shortcut_use';
          await DbApiUtil.logCommandToDb(modalPrivateMetadata);
          const slackView = SlackBlockUtil.getErrorSlackView(
            'not_active_voter_parent_thread',
            'This shortcut is not valid on this message.'
          );
          await SlackApiUtil.updateModal(viewId, slackView);
          logger.info(
            `ASYNCJOBS.slackInteractivityHandler: Volunteer used a route to journey shortcut on an invalid message.`
          );
          return;
        }

        await SlackInteractionHandler.receiveRouteToJourney({
          payload,
          redisClient,
          modalPrivateMetadata,
          twilioPhoneNumber: redisData.twilioPhoneNumber,
          userId: MD5.hex(redisData.userPhoneNumber),
          viewId,
        });
        return;
      }

      default: {
        throw new Error(
          `slackInteractivityHandler unrecognized callback_id ${payload.callback_id}`
        );
      }
    }
  }

  // Block action
  if (payload.type === 'block_actions') {
    const actionId = payload.actions[0]?.action_id;
    // match the *prefix* for the expand action, since we have multiple page buttons and
    // the action_ids have to be unique
    if (actionId?.startsWith(SlackActionId.VOTER_SESSION_EXPAND)) {
      await SlackInteractionHandler.handleSessionShow(payload);
      return;
    }
    switch (actionId) {
      case SlackActionId.VOTER_SESSION_HIDE: {
        await SlackInteractionHandler.handleSessionHide(payload);
        return;
      }
      case SlackActionId.RESET_DEMO: {
        const redisHashKey = `${payload.channel.id}:${payload.message.ts}`;
        const redisData = await RedisApiUtil.getHash(redisClient, redisHashKey);
        const modalPrivateMetadata = {
          commandType: 'RESET_DEMO',
          userId: redisData ? MD5.hex(redisData.userPhoneNumber) : null,
          userPhoneNumber: redisData ? redisData.userPhoneNumber : null,
          twilioPhoneNumber: redisData ? redisData.twilioPhoneNumber : null,
          slackChannelId: payload.channel.id,
          slackParentMessageTs: payload.message.ts,
          originatingSlackUserName: originatingSlackUserName,
          originatingSlackUserId: payload.user.id,
          actionTs: payload.action_ts,
        } as SlackModalPrivateMetadata;
        await SlackInteractionHandler.handleResetDemo(
          redisClient,
          modalPrivateMetadata
        );
        return;
      }
      case SlackActionId.ROUTE_TO_JOURNEY: {
        const redisHashKey = `${payload.channel.id}:${payload.message.ts}`;
        const redisData = await RedisApiUtil.getHash(redisClient, redisHashKey);
        const userId = MD5.hex(redisData.userPhoneNumber);
        const redisUserInfoKey = `${userId}:${redisData.twilioPhoneNumber}`;
        const userInfo = (await RedisApiUtil.getHash(
          redisClient,
          redisUserInfoKey
        )) as UserInfo;
        try {
          const destinationChannelName = await LoadBalancer.getJourneyChannel(
            redisClient,
            userInfo
          );
          const modalPrivateMetadata = {
            commandType: 'ROUTE_TO_JOURNEY',
            userId: MD5.hex(redisData.userPhoneNumber),
            twilioPhoneNumber: redisData.twilioPhoneNumber,
            originatingSlackUserName: originatingSlackUserName,
            originatingSlackUserId: payload.user.id,
            slackChannelId: payload.channel.id,
            slackParentMessageTs: thread_ts,
            destinationSlackChannelName: destinationChannelName,
          } as SlackModalPrivateMetadata;
          await SlackInteractionHandler.handleRouteToJourney(
            redisClient,
            modalPrivateMetadata
          );
        } catch (error) {
          logger.info(error);
        }
        return;
      }
      case SlackActionId.MANAGE_ENTRY_POINTS_FILTER_STATE:
      case SlackActionId.MANAGE_ENTRY_POINTS_FILTER_TYPE: {
        logger.info(
          `SERVER POST /slack-interactivity: Determined user interaction is in MANAGE_ENTRY_POINTS modal`
        );

        const view = payload.view;
        if (!view) {
          throw new Error('MANAGE_ENTRY_POINTS block_actions expected view');
        }

        await SlackInteractionHandler.handleManageEntryPoints({
          payload,
          redisClient,
          originatingSlackUserName,
          viewId: payload.view.id,
          values: payload.view.state?.values,
          action: payload.actions[0],
        });
        return;
      }

      case SlackActionId.MANAGE_ENTRY_POINTS_CHANNEL_STATE_DROPDOWN: {
        // Noop -- this gets handled with submission
        return;
      }
    }

    // Fallback behavior for block actions introduced prior to use of action IDs
    const originatingSlackChannelName = await SlackApiUtil.fetchSlackChannelName(
      payload.channel.id
    );
    if (!originatingSlackChannelName) {
      throw new Error(
        `Could not get slack channel name for Slack channel ${payload.channel.id}`
      );
    }

    const redisHashKey = `${payload.channel.id}:${payload.message.ts}`;
    const redisData = await RedisApiUtil.getHash(redisClient, redisHashKey);
    if (!redisData) {
      logger.debug(
        `SERVER POST /slack-interactivity: Received an interaction for a voter who no longer exists in Redis.`
      );
      return;
    }
    const redisUserInfoKey = `${MD5.hex(redisData.userPhoneNumber)}:${
      redisData.twilioPhoneNumber
    }`;
    const userInfo = (await RedisApiUtil.getHash(
      redisClient,
      redisUserInfoKey
    )) as UserInfo;
    if (!userInfo) {
      logger.error(
        `SERVER POST /slack-interactivity: missing userInfo for ${redisUserInfoKey}`
      );
      return;
    }

    if (
      payload.actions[0].action_id === SlackActionId.VOTER_STATUS_DROPDOWN ||
      payload.actions[0].action_id ===
        SlackActionId.VOTER_STATUS_REFUSED_BUTTON ||
      payload.actions[0].action_id === SlackActionId.VOTER_STATUS_SPAM_BUTTON ||
      payload.actions[0].action_id ===
        SlackActionId.CLOSED_VOTER_PANEL_UNDO_BUTTON
    ) {
      logger.info(
        `SERVER POST /slack-interactivity: Determined user interaction is a voter status update or undo.`
      );
      let selectedVoterStatus = payload.actions[0].selected_option
        ? payload.actions[0].selected_option.value
        : payload.actions[0].value;
      if (selectedVoterStatus === 'ALREADY_VOTED') {
        // take this opportunity to update the voter status blocks!
        selectedVoterStatus = 'VOTED';
        payload.message.blocks[2] = cloneDeep(SlackBlockUtil.voterStatusPanel);
      }
      await SlackInteractionHandler.handleVoterStatusUpdate({
        userInfo,
        payload,
        selectedVoterStatus: selectedVoterStatus as SlackInteractionHandler.VoterStatusUpdate,
        originatingSlackUserName,
        slackChannelName: originatingSlackChannelName,
        userPhoneNumber: redisData.userPhoneNumber,
        twilioPhoneNumber: redisData.twilioPhoneNumber,
        redisClient,
      });
    } else if (
      payload.actions[0].action_id === SlackActionId.VOLUNTEER_DROPDOWN ||
      payload.actions[0].action_id === SlackActionId.VOLUNTEER_RELEASE_CLAIM
    ) {
      logger.info(
        `SERVER POST /slack-interactivity: Determined user interaction is a volunteer update.`
      );
      await SlackInteractionHandler.handleVolunteerUpdate({
        userInfo,
        payload,
        originatingSlackUserName,
        slackChannelName: originatingSlackChannelName,
        userPhoneNumber: redisData.userPhoneNumber,
        twilioPhoneNumber: redisData.twilioPhoneNumber,
      });
    } else if (payload.actions[0].action_id === SlackActionId.SESSION_TOPICS) {
      logger.info(
        `SERVER POST /slack-interactivity: Determined user interaction is a session topics update.`
      );
      await SlackInteractionHandler.handleSessionTopicUpdate({
        payload: payload,
        userId: MD5.hex(redisData.userPhoneNumber),
        twilioPhoneNumber: redisData.twilioPhoneNumber,
      });
    } else {
      throw Error(`Unrecognized action_id ${payload.actions[0].action_id}`);
    }
    return;
  }

  // If the interaction is submission of a modal.
  if (payload.type === 'view_submission') {
    const viewId = payload.view?.id;
    if (!viewId) {
      // This should never happen. If it does, it's a Slack bug.
      throw new Error('view_submission missing view.id?');
    }

    switch (payload.view.callback_id) {
      // The MANAGE_ENTRY_POINTS_MODAL callback ID is set when the user submits options
      // for adjusting the weights of different channels for load balancing.
      case SlackCallbackId.MANAGE_ENTRY_POINTS: {
        logger.info(
          `SERVER POST /slack-interactivity: Determined user interaction is a MANAGE_ENTRY_POINTS_MODAL submission.`
        );

        await SlackInteractionHandler.handleManageEntryPoints({
          payload,
          redisClient,
          originatingSlackUserName,
          viewId,
          values: payload?.view?.state?.values,
          isSubmission: true,
        });
        return;
      }

      // If the submission for MANAGE_ENTRY_POINTS_MODAL zero-ed out the weights for
      // a particular entrypoint, we warn the user and ask for confirmation. If they
      // confirm, we get this MANAGE_ENTRY_POINTS_CONFIRM_MODAL callback ID which
      // contains the original view's values in its private_metadata
      case SlackCallbackId.MANAGE_ENTRY_POINTS_CONFIRM: {
        logger.info(
          `SERVER POST /slack-interactivity: Determined user interaction is a MANAGE_ENTRY_POINTS_MODAL_CONFIRM submission.`
        );

        const rootViewId = payload.view?.root_view_id;
        if (!rootViewId) {
          // This should never happen. If it does, it's a Slack bug.
          throw new Error('view_submission missing view.root_view_id"');
        }

        await SlackInteractionHandler.handleManageEntryPoints({
          payload,
          redisClient,
          originatingSlackUserName,
          viewId: rootViewId,
          values: JSON.parse(payload?.view?.private_metadata),
          isSubmission: true,
        });
        return;
      }

      case SlackCallbackId.RESET_DEMO: {
        const modalPrivateMetadata = JSON.parse(
          payload.view.private_metadata
        ) as SlackModalPrivateMetadata;
        if (modalPrivateMetadata.commandType !== 'RESET_DEMO') {
          throw new Error(
            `Got callback ID RESET_DEMO but private commandType was ${modalPrivateMetadata.commandType}`
          );
        }
        await SlackInteractionHandler.handleResetDemo(
          redisClient,
          modalPrivateMetadata
        );
        return;
      }

      case SlackCallbackId.ROUTE_TO_JOURNEY: {
        const modalPrivateMetadata = SlackInteractionHandler.parseSlackModalPrivateMetadata(
          payload.view.private_metadata
        );
        if (
          modalPrivateMetadata &&
          modalPrivateMetadata.commandType !== 'ROUTE_TO_JOURNEY'
        ) {
          throw new Error(
            `Got callback ID ROUTE_TO_JOURNEY but private commandType was ${modalPrivateMetadata.commandType}`
          );
        }
        await SlackInteractionHandler.handleRouteToJourney(
          redisClient,
          modalPrivateMetadata
        );
        return;
      }

      default: {
        throw new Error(
          `SERVER POST /slack-interactivity: Unrecognized callback_id for view_submission ${payload.view.callback_id}`
        );
      }
    }

    // If the view_submission interaction does not match one of the above types
    // exit and continue down to throw an error.
  }

  throw new Error(
    `Received an unexpected Slack interaction: ${JSON.stringify(payload)}`
  );
}

async function slackMessageEventHandler(
  reqBody: SlackEventRequestBody,
  twilioCallbackURL: string,
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
        twilioCallbackURL,
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
  slackCommandHandler,
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
