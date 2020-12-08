import Hashes from 'jshashes';

import * as MessageConstants from './message_constants';
import * as SlackApiUtil from './slack_api_util';
import * as SlackBlockUtil from './slack_block_util';
import * as TwilioApiUtil from './twilio_api_util';
import * as StateParser from './state_parser';
import * as DbApiUtil from './db_api_util';
import * as RedisApiUtil from './redis_api_util';
import * as LoadBalancer from './load_balancer';
import * as SlackMessageFormatter from './slack_message_formatter';
import * as CommandUtil from './command_util';
import * as MessageParser from './message_parser';
import * as SlackInteractionApiUtil from './slack_interaction_api_util';
import logger from './logger';
import { EntryPoint, SessionTopics, UserInfo } from './types';
import { PromisifiedRedisClient } from './redis_client';
import * as Sentry from '@sentry/node';
import { isVotedKeyword } from './keyword_parser';
import { SlackActionId } from './slack_interaction_ids';
import { SlackFile } from './message_parser';

const MINS_BEFORE_WELCOME_BACK_MESSAGE = 60 * 24;
export const NUM_STATE_SELECTION_ATTEMPTS_LIMIT = 2;

type UserOptions = {
  userMessage: string;
  userAttachments: string[];
  userPhoneNumber: string;
};

export type AdminCommandParams = {
  commandParentMessageTs: string | null;
  commandMessageTs: string | null; // if command is in a thread, this is the in-thread message
  commandChannel: string | null;
  routingSlackUserName: string;
  previousSlackChannelName: string;
};

export function isStaleSession(userInfo: UserInfo): boolean {
  if (!userInfo.sessionStartEpoch) {
    // legacy session from before 2020-11-03 election
    return true;
  }

  // add other "stale" logic here (e.g., session is idle for >2 months)
  // ...

  return false;
}

// prepareUserInfoForNewVoter is used by functions that handle
// phone numbers not previously seen.
export function prepareUserInfoForNewVoter({
  userOptions,
  twilioPhoneNumber,
  entryPoint,
  returningVoter,
}: {
  userOptions: UserOptions & { userId: string; userPhoneNumber: string | null };
  twilioPhoneNumber: string;
  entryPoint: EntryPoint;
  returningVoter: boolean;
}): UserInfo {
  let isDemo, confirmedDisclaimer, volunteerEngaged;
  if (entryPoint === LoadBalancer.PULL_ENTRY_POINT) {
    isDemo = LoadBalancer.phoneNumbersAreDemo(
      twilioPhoneNumber,
      userOptions.userPhoneNumber
    );
    logger.debug(
      `ROUTER.prepareUserInfoForNewVoter (${userOptions.userId}): Evaluating isDemo based on userPhoneNumber/twilioPhoneNumber: ${isDemo}`
    );
    confirmedDisclaimer = false;
    volunteerEngaged = false;
  }

  return {
    userId: userOptions.userId,
    twilioPhoneNumber: twilioPhoneNumber,
    // Necessary for admin controls, so userPhoneNumber can be found even though
    // admins specify only userId.
    userPhoneNumber: userOptions.userPhoneNumber,
    isDemo,
    confirmedDisclaimer,
    volunteerEngaged,
    lastVoterMessageSecsFromEpoch: Math.round(Date.now() / 1000),
    // Not necessary except for DB logging purposes. The twilioPhoneNumber reveals
    // the entry point. But to log for automated messages and Slack-to-Twilio
    // messages, this is necessary.
    entryPoint,
    numStateSelectionAttempts: 0,
    // Start time for this session, with a bit of slop to capture the first message
    sessionStartEpoch: Math.round(Date.now() / 1000) - 10,
    returningVoter: returningVoter,
  } as UserInfo;
}

export async function endVoterSession(
  redisClient: PromisifiedRedisClient,
  userInfo: UserInfo,
  twilioPhoneNumber: string
): Promise<void> {
  // end old session thread(s)
  await DbApiUtil.setSessionEnd(userInfo.userId, twilioPhoneNumber);

  // clear any assigned volunteer
  await DbApiUtil.logVolunteerVoterClaimToDb({
    userId: userInfo.userId,
    userPhoneNumber: userInfo.userPhoneNumber,
    twilioPhoneNumber,
    isDemo: LoadBalancer.phoneNumbersAreDemo(
      twilioPhoneNumber,
      userInfo.userPhoneNumber
    ),
    volunteerSlackUserName: null,
    volunteerSlackUserId: null,
    originatingSlackUserName: null,
    originatingSlackUserId: null,
    slackChannelName: null,
    slackChannelId: null,
    slackParentMessageTs: null,
    actionTs: null,
  });

  // delete userInfo
  const redisHashKey = `${userInfo.userId}:${twilioPhoneNumber}`;
  await RedisApiUtil.deleteKeys(redisClient, [redisHashKey]);

  // update old session thread's panel async; do not await
  void SlackBlockUtil.closeVoterPanel(
    userInfo,
    'This voter helpline session is closed'
  );
}

export async function welcomePotentialVoter(
  userInfo: UserInfo,
  userOptions: UserOptions & { userId: string },
  redisClient: PromisifiedRedisClient,
  twilioPhoneNumber: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry,
  entryPoint: EntryPoint,
  twilioCallbackURL: string
): Promise<void> {
  logger.debug('ENTERING ROUTER.welcomePotentialVoter');

  let messageToVoter = MessageConstants.WELCOME_VOTER();
  if (isVotedKeyword(userOptions.userMessage)) {
    messageToVoter = MessageConstants.VOTED_WELCOME_RESPONSE();
    await DbApiUtil.logVoterStatusToDb({
      userId: userInfo.userId,
      userPhoneNumber: userInfo.userPhoneNumber,
      twilioPhoneNumber: twilioPhoneNumber,
      isDemo: userInfo.isDemo,
      voterStatus: 'VOTED',
      originatingSlackUserName: null,
      originatingSlackUserId: null,
      slackChannelName: null,
      slackChannelId: null,
      slackParentMessageTs: null,
      actionTs: null,
    });
  }
  await TwilioApiUtil.sendMessage(
    messageToVoter,
    {
      userPhoneNumber: userOptions.userPhoneNumber,
      twilioPhoneNumber,
      twilioCallbackURL,
    },
    DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
  );

  DbApiUtil.updateDbMessageEntryWithUserInfo(userInfo!, inboundDbMessageEntry);

  // The message isn't being relayed, so don't fill this field in Postgres.
  inboundDbMessageEntry.successfullySent = null;
  try {
    await DbApiUtil.logMessageToDb(inboundDbMessageEntry);
  } catch (error) {
    logger.info(
      `ROUTER.welcomePotentialVoter: failed to log incoming voter message to DB`
    );
    Sentry.captureException(error);
  }

  // Add key/value such that given a user phone number we can see
  // that the voter has been encountered before, even if there is not
  // yet any Slack channel/thread info for this voter.
  logger.debug(
    `ROUTER.welcomePotentialVoter: Writing new voter userInfo to Redis.`
  );
  await RedisApiUtil.setHash(
    redisClient,
    `${userInfo.userId}:${twilioPhoneNumber}`,
    userInfo
  );
}

async function introduceNewVoterToSlackChannel(
  {
    userInfo,
    userMessage,
    userAttachments,
  }: { userInfo: UserInfo; userMessage: string; userAttachments: string[] },
  redisClient: PromisifiedRedisClient,
  twilioPhoneNumber: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry | null,
  entryPoint: EntryPoint,
  slackChannelName: string,
  twilioCallbackURL: string,
  // This is only used by VOTE_AMERICA
  includeWelcome?: boolean,
  noWelcome?: boolean
): Promise<string> {
  logger.debug('ENTERING ROUTER.introduceNewVoterToSlackChannel');
  logger.debug(
    `ROUTER.introduceNewVoterToSlackChannel: Updating lastVoterMessageSecsFromEpoch to ${userInfo.lastVoterMessageSecsFromEpoch}`
  );

  logger.debug(
    `ROUTER.introduceNewVoterToSlackChannel: Announcing new voter via new thread in ${slackChannelName}.`
  );

  // If the voter has previously communicated that they already voted, we have them
  // enter the helpline with "Voted" prepopulated as their status.
  const status = await DbApiUtil.getLatestVoterStatus(
    userInfo.userId,
    twilioPhoneNumber
  );

  const slackBlocks = await SlackBlockUtil.getVoterPanel(
    userInfo,
    twilioPhoneNumber,
    undefined,
    status || 'UNKNOWN'
  );

  let response = {
    data: {
      channel: 'NONEXISTENT_LOBBY',
      ts: 'NONEXISTENT_LOBBY_TS',
    },
  } as SlackApiUtil.SlackSendMessageResponse | null;

  response = await SlackApiUtil.sendMessage(slackBlocks[0].text.text, {
    channel: slackChannelName,
    blocks: slackBlocks,
  });

  let messageToVoter;
  if (process.env.CLIENT_ORGANIZATION === 'VOTE_AMERICA') {
    if (includeWelcome) {
      // Voter initiated conversation with "HELPLINE".
      if (userInfo.stateName) {
        messageToVoter = MessageConstants.WELCOME_FINDING_VOLUNTEER();
      } else {
        messageToVoter = MessageConstants.WELCOME_AND_STATE_QUESTION();
      }
    } else {
      // Voter has already received automated welcome and is just now responding with "HELPLINE".
      if (userInfo.stateName) {
        messageToVoter = MessageConstants.FINDING_VOLUNTEER();
      } else {
        messageToVoter = MessageConstants.STATE_QUESTION();
      }
    }
  } else {
    messageToVoter = MessageConstants.WELCOME_VOTER();
  }

  if (response) {
    if (!noWelcome && entryPoint === LoadBalancer.PULL_ENTRY_POINT) {
      logger.debug(
        `ROUTER.introduceNewVoterToSlackChannel: Entry point is PULL, so sending automated welcome to voter.`
      );
      // Welcome the voter
      await TwilioApiUtil.sendMessage(
        messageToVoter,
        {
          userPhoneNumber: userInfo.userPhoneNumber,
          twilioPhoneNumber,
          twilioCallbackURL,
        },
        DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
      );
    }
  } else {
    await TwilioApiUtil.sendMessage(
      `There was an unexpected error sending your message. Please wait a few minutes and try again.`,
      {
        userPhoneNumber: userInfo.userPhoneNumber,
        twilioPhoneNumber,
        twilioCallbackURL,
      },
      DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
    );
    throw new Error(
      `Could not send introduction slack message with voter info for voter ${userInfo.userPhoneNumber} texting ${twilioPhoneNumber}`
    );
  }

  logger.debug(`ROUTER.introduceNewVoterToSlackChannel: Successfully announced new voter via new thread in ${slackChannelName},
                response.data.channel: ${response.data.channel},
                response.data.ts: ${response.data.ts}`);

  // Remember the thread for this user and this channel,
  // using the ID version of the channel.
  userInfo[response.data.channel] = response.data.ts;

  // Create the thread
  await DbApiUtil.logThreadToDb({
    slackParentMessageTs: response.data.ts,
    channelId: response.data.channel,
    userId: userInfo.userId,
    userPhoneNumber: userInfo.userPhoneNumber,
    twilioPhoneNumber: twilioPhoneNumber,
    needsAttention: true,
    isDemo: userInfo.isDemo,
    sessionStartEpoch: userInfo.sessionStartEpoch || null,
  });

  // Set active channel to this first channel, since the voter is new.
  // Makes sure subsequent messages from the voter go to this channel, unless
  // this active channel is changed.
  userInfo.activeChannelId = response.data.channel;
  userInfo.activeChannelName = slackChannelName;

  // Depending on the entry point, either:
  // PULL: Pass user message to Slack and then automated reply.
  // PUSH/some clients: Write user reply to database and then pass message history to Slack.
  if (
    entryPoint === LoadBalancer.PUSH_ENTRY_POINT ||
    process.env.CLIENT_ORGANIZATION === 'VOTE_AMERICA'
  ) {
    logger.debug(
      `ROUTER.introduceNewVoterToSlackChannel: Retrieving and passing message history to Slack, slackChannelName: ${slackChannelName}, parentMessageTs: ${response.data.channel}.`
    );

    if (!inboundDbMessageEntry) {
      logger.debug(
        `ROUTER.introduceNewVoterToSlackChannel: reopen empty session thread, slackChannelName: ${slackChannelName}, parentMessageTs: ${response.data.channel}.`
      );
    } else {
      DbApiUtil.updateDbMessageEntryWithUserInfo(
        userInfo!,
        inboundDbMessageEntry
      );
      inboundDbMessageEntry.slackChannel = response.data.channel;
      inboundDbMessageEntry.slackParentMessageTs = response.data.ts;
      inboundDbMessageEntry.slackSendTimestamp = new Date();
      // The message will be relayed via the message history, so this field isn't relevant.
      inboundDbMessageEntry.successfullySent = null;
      try {
        await DbApiUtil.logMessageToDb(inboundDbMessageEntry);
      } catch (error) {
        logger.info(
          `ROUTER.introduceNewVoterToSlackChannel: failed to log incoming voter message to DB`
        );
        Sentry.captureException(error);
      }
    }

    await postUserMessageHistoryToSlack(
      redisClient,
      userInfo,
      twilioPhoneNumber,
      {
        destinationSlackParentMessageTs: response.data.ts,
        destinationSlackChannelId: response.data.channel,
      }
    );
  } else if (entryPoint === LoadBalancer.PULL_ENTRY_POINT) {
    // Pass the voter's message along to the initial Slack channel thread,
    // and show in the Slack thread the welcome message the voter received
    // in response.
    logger.debug(
      `ROUTER.introduceNewVoterToSlackChannel: Passing voter message to Slack, slackChannelName: ${slackChannelName}, parentMessageTs: ${response.data.ts}.`
    );
    if (inboundDbMessageEntry) {
      const blocks = SlackBlockUtil.formatMessageWithAttachmentLinks(
        userMessage,
        userAttachments
      );
      await SlackApiUtil.sendMessage(
        blocks[0].text.text,
        {
          parentMessageTs: response.data.ts,
          blocks,
          channel: response.data.channel,
          isVoterMessage: true,
        },
        inboundDbMessageEntry,
        userInfo
      );
    }

    logger.debug(
      `ROUTER.introduceNewVoterToSlackChannel: Passing automated welcome message to Slack, slackChannelName: ${slackChannelName}, parentMessageTs: ${response.data.channel}.`
    );
    await SlackApiUtil.sendMessage(messageToVoter, {
      parentMessageTs: response.data.ts,
      channel: response.data.channel,
      isAutomatedMessage: true,
    });
  }

  // Add key/value such that given a user phone number we can get the
  // Slack channel thread associated with that user.
  logger.debug(
    `ROUTER.introduceNewVoterToSlackChannel: Writing updated userInfo to Redis.`
  );
  await RedisApiUtil.setHash(
    redisClient,
    `${userInfo.userId}:${twilioPhoneNumber}`,
    userInfo
  );

  // Add key/value such that given Slack thread data we can get a
  // user phone number.
  logger.debug(
    `ROUTER.introduceNewVoterToSlackChannel: Writing updated Slack-to-Twilio redisData to Redis.`
  );
  await RedisApiUtil.setHash(
    redisClient,
    `${response.data.channel}:${response.data.ts}`,
    { userPhoneNumber: userInfo.userPhoneNumber, twilioPhoneNumber }
  );
  return response.data.ts;
}

export async function handleNewVoter(
  userInfo: UserInfo,
  userOptions: UserOptions & { userId: string },
  redisClient: PromisifiedRedisClient,
  twilioPhoneNumber: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry,
  entryPoint: EntryPoint,
  twilioCallbackURL: string,
  includeWelcome?: boolean
): Promise<void> {
  logger.debug('ENTERING ROUTER.handleNewVoter');
  const userMessage = userOptions.userMessage;

  await DbApiUtil.logInitialVoterStatusToDb(
    userInfo.userId,
    userOptions.userPhoneNumber,
    twilioPhoneNumber,
    userInfo.isDemo
  );

  let slackChannelName = null as string | null;

  // Do we already know the voter's state?
  if (process.env.CLIENT_ORGANIZATION === 'VOTE_AMERICA') {
    const knownState = await DbApiUtil.getKnownPhoneState(
      userOptions.userPhoneNumber
    );
    if (knownState) {
      // The knownState value from the db is probably a state abbreviation, so we need to resolve it
      const stateName = StateParser.determineState(knownState);
      if (stateName) {
        // Success: we know the state
        userInfo.stateName = stateName;
        userInfo.panelmessage = 'known phone number';
        slackChannelName = await LoadBalancer.selectSlackChannel(
          redisClient,
          LoadBalancer.PULL_ENTRY_POINT,
          stateName,
          userInfo.isDemo
        );
        if (slackChannelName) {
          // We can route them too
          logger.info(
            `ROUTER.handleNewVoter (${userInfo.userId}): New voter is in known state {stateName}, selected Slack channel {slackChannelName}`
          );
        } else {
          // That state doesn't route for some reason; go to national
          slackChannelName = userInfo.isDemo ? 'demo-national' : 'national';
          logger.info(
            `ROUTER.handleNewVoter (${userInfo.userId}): New voter is in known state {stateName}, but no channel match`
          );
        }
      } else {
        logger.warning(
          `ROUTER.handleNewVoter (${userInfo.userId}): unable to parse known state '${knownState}`
        );
      }
    }
  }

  if (!slackChannelName) {
    slackChannelName = userInfo.isDemo ? 'demo-lobby' : 'lobby';
    if (entryPoint === LoadBalancer.PULL_ENTRY_POINT) {
      logger.debug(
        `ROUTER.handleNewVoter (${userInfo.userId}): New voter will enter Slack channel: ${slackChannelName}`
      );
    } else if (entryPoint === LoadBalancer.PUSH_ENTRY_POINT) {
      userInfo.stateName = LoadBalancer.getPushPhoneNumberState(
        twilioPhoneNumber
      );
      logger.debug(
        `ROUTER.handleNewVoter (${userInfo.userId}): Determined that twilioPhoneNumber ${twilioPhoneNumber} corresponds to U.S. state ${userInfo.stateName} based on hard coding in LoadBalancer.`
      );
      const selectedChannelName = await LoadBalancer.selectSlackChannel(
        redisClient,
        LoadBalancer.PUSH_ENTRY_POINT,
        userInfo.stateName
      );

      logger.debug(
        `ROUTER.handleNewVoter (${userInfo.userId}): LoadBalancer returned Slack channel ${selectedChannelName} for new PUSH voter.`
      );
      if (selectedChannelName) {
        slackChannelName = selectedChannelName;
      } else {
        // If LoadBalancer didn't find a Slack channel, then select #national or #demo-national as fallback.
        slackChannelName = userInfo.isDemo ? 'demo-national' : 'national';
        logger.error(
          `ROUTER.handleNewVoter (${userInfo.userId}): ERROR LoadBalancer did not find a Slack channel for new PUSH voter. Using ${slackChannelName} as fallback.`
        );
      }
    }
  }

  await introduceNewVoterToSlackChannel(
    {
      userInfo: userInfo as UserInfo,
      userMessage,
      userAttachments: userOptions.userAttachments,
    },
    redisClient,
    twilioPhoneNumber,
    inboundDbMessageEntry,
    entryPoint,
    slackChannelName,
    twilioCallbackURL,
    includeWelcome
  );
}

async function postUserMessageHistoryToSlack(
  redisClient: PromisifiedRedisClient,
  userInfo: UserInfo,
  twilioPhoneNumber: string,
  {
    destinationSlackParentMessageTs,
    destinationSlackChannelId,
  }: {
    destinationSlackParentMessageTs: string;
    destinationSlackChannelId: string;
  }
): Promise<string | null> {
  logger.debug('ENTERING ROUTER.postUserMessageHistoryToSlack');

  // past sessions
  const sessionHistory = await DbApiUtil.getPastSessionThreads(
    userInfo.userId,
    twilioPhoneNumber
  );
  if (sessionHistory?.length > 0) {
    const slackChannelIds = await RedisApiUtil.getHash(
      redisClient,
      'slackPodChannelIds'
    );
    const slackChannelNames: Record<string, string> = {};
    for (const name in slackChannelIds) {
      slackChannelNames[slackChannelIds[name]] = name;
    }

    for (const thread of sessionHistory) {
      const url = await SlackApiUtil.getThreadPermalink(
        thread.channelId,
        thread.historyTs || thread.slackParentMessageTs
      );
      const lastUpdateEpoch = Date.parse(thread.lastUpdate || '') / 1000;
      const endTime = `<!date^${lastUpdateEpoch}^{time} {date_short}|${lastUpdateEpoch}>`;
      let description = `Past session in ${SlackApiUtil.linkToSlackChannel(
        thread.channelId,
        slackChannelNames[thread.channelId]
      )} ended ${endTime} - <${url}|Open>`;
      if (thread?.topics) {
        description +=
          '\nTopics: ' +
          thread.topics
            .map((k) => {
              return SessionTopics[k];
            })
            .join(', ');
      }
      await SlackApiUtil.sendMessage('', {
        parentMessageTs: destinationSlackParentMessageTs,
        channel: destinationSlackChannelId,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: description,
            },
          },
          {
            type: 'actions',
            elements: [
              {
                type: 'button',
                style: 'primary',
                text: {
                  type: 'plain_text',
                  text: 'Show',
                  emoji: true,
                },
                action_id: SlackActionId.VOTER_SESSION_EXPAND,
                value: `${userInfo.userId} ${twilioPhoneNumber} ${thread.sessionStartEpoch} ${thread.sessionEndEpoch} 0`,
              },
            ],
          },
        ],
      });
    }
  }

  // messages
  const messageHistory = await DbApiUtil.getMessageHistoryFor(
    userInfo.userId,
    twilioPhoneNumber,
    DbApiUtil.epochToPostgresTimestamp(userInfo.sessionStartEpoch || 0)
  );

  // Just in case.
  if (!messageHistory) {
    logger.debug(
      'ROUTER.postUserMessageHistoryToSlack: No message history found.'
    );
    return null;
  }

  let messageHistoryContext = "Below is the voter's message history so far.";
  if (messageHistory.length == 0) {
    messageHistoryContext =
      'This helpline session has no message history (yet).';
  }

  logger.debug(
    'ROUTER.postUserMessageHistoryToSlack: Message history found, formatting it by calling SlackMessageFormatter.'
  );
  const formattedMessageHistory = SlackMessageFormatter.formatMessageHistory(
    messageHistory,
    userInfo.userId.substring(0, 5)
  ).join('\n\n');

  const msgInfo = await SlackApiUtil.sendMessage(
    `${messageHistoryContext}\n\n${formattedMessageHistory}`,
    {
      parentMessageTs: destinationSlackParentMessageTs,
      channel: destinationSlackChannelId,
    }
  );
  if (msgInfo) {
    await DbApiUtil.setThreadHistoryTs(
      destinationSlackParentMessageTs,
      destinationSlackChannelId,
      msgInfo.data.ts
    );
    return msgInfo.data.ts;
  } else {
    return null;
  }
}

// This function routes a voter to a new channel WHETHER OR NOT they have
// previously been to that channel before, creating a new thread if needed.
export async function routeVoterToSlackChannel(
  userInfo: UserInfo,
  redisClient: PromisifiedRedisClient,
  {
    twilioPhoneNumber,
    destinationSlackChannelName,
  }: {
    twilioPhoneNumber: string;
    destinationSlackChannelName: string;
  },
  adminCommandParams?: AdminCommandParams /* only for admin rerouteVoterToSlackChannel-routes or Route to Journey shortcut (not automated)*/
): Promise<void> {
  logger.debug('ENTERING ROUTER.routeVoterToSlackChannel');
  const userPhoneNumber = userInfo.userPhoneNumber;

  // TODO: Consider doing this fetch within handleSlackAdminCommand, especially
  // when adding new commands that require fetching a Slack channel ID.
  let slackChannelIds = await RedisApiUtil.getHash(
    redisClient,
    'slackPodChannelIds'
  );
  let destinationSlackChannelId = slackChannelIds
    ? slackChannelIds[destinationSlackChannelName]
    : null;
  logger.debug(
    `ROUTER.routeVoterToSlackChannel: Determined destination Slack channel ID: ${destinationSlackChannelId}`
  );

  // If a destinationSlackChannelId was not fetched from Redis, refresh Redis's slackPodChannelIds cache
  // data via a call to Slack's conversation.list API and try again.
  if (!destinationSlackChannelId) {
    logger.debug(
      `ROUTER.routeVoterToSlackChannel: destinationSlackChannelId (${destinationSlackChannelId}) not found in Redis, refreshing slackPodChannelIds key using Slack conversations.list call.`
    );
    await SlackApiUtil.updateSlackChannelNamesAndIdsInRedis(redisClient);
    slackChannelIds = await RedisApiUtil.getHash(
      redisClient,
      'slackPodChannelIds'
    );
    destinationSlackChannelId = slackChannelIds[destinationSlackChannelName];
    logger.debug(
      `ROUTER.routeVoterToSlackChannel: Resulting Slack channel ID using Slack channel name (${destinationSlackChannelName}) after Slack conversations.list call: ${destinationSlackChannelId}`
    );
  }

  // Operations for successful ADMIN route of voter (admin command or Route to Journey).
  if (adminCommandParams) {
    // Error catching for admin command: destination channel not found.
    if (!destinationSlackChannelId) {
      logger.debug(
        'ROUTER.routeVoterToSlackChannel: destinationSlackChannelId not found. Did you forget to add it to slackPodChannelIds in Redis? Or if this is an admin action, did the admin type it wrong?'
      );
      // Only respond to the admin command if it's a admin control room command (not Route to Journey shortcut).
      if (
        adminCommandParams.commandChannel &&
        adminCommandParams.commandParentMessageTs &&
        adminCommandParams.commandMessageTs
      ) {
        await SlackApiUtil.sendMessage(
          `*Operator:* Slack channel ${destinationSlackChannelName} not found.`,
          {
            channel: adminCommandParams.commandChannel,
            parentMessageTs: adminCommandParams.commandParentMessageTs,
          }
        );
        await SlackApiUtil.addSlackMessageReaction(
          adminCommandParams.commandChannel,
          adminCommandParams.commandMessageTs,
          'x'
        );
        return;
      }
    }

    // TODO: This should probably be a lot later in the routing of the voter.
    logger.debug(
      'ROUTER.routeVoterToSlackChannel: Routing of voter should succeed from here on out. Letting the admin (if applicable) know.'
    );
    await SlackApiUtil.sendMessage(
      `*Operator:* Voter is being routed to ${SlackApiUtil.linkToSlackChannel(
        destinationSlackChannelId,
        destinationSlackChannelName
      )} by *${adminCommandParams.routingSlackUserName}*.`,
      {
        channel: userInfo.activeChannelId,
        parentMessageTs: userInfo[userInfo.activeChannelId],
      }
    );
    // Operations for AUTOMATED route of voter.
  } else {
    await SlackApiUtil.sendMessage(
      `*Operator:* Routing voter to ${SlackApiUtil.linkToSlackChannel(
        destinationSlackChannelId,
        destinationSlackChannelName
      )}.`,
      {
        channel: userInfo.activeChannelId,
        parentMessageTs: userInfo[userInfo.activeChannelId],
      }
    );
  }

  // The old thread no longer needs attention
  const needsAttention = await DbApiUtil.getThreadNeedsAttentionFor(
    userInfo[userInfo.activeChannelId],
    userInfo.activeChannelId
  );
  const oldSlackParentMessageTs = userInfo[userInfo.activeChannelId];
  const oldChannelId = userInfo.activeChannelId;

  if (userInfo.activeChannelId !== 'NONEXISTENT_LOBBY') {
    // Close old voter panel
    await SlackBlockUtil.closeVoterPanel(
      userInfo,
      `Voter has been routed to ${SlackApiUtil.linkToSlackChannel(
        destinationSlackChannelId,
        destinationSlackChannelName
      )}.`
    );
  }

  logger.debug(
    'ROUTER.routeVoterToSlackChannel: Successfully updated old thread parent message during channel move'
  );

  // Create new thread in the channel.
  logger.debug(
    `ROUTER.routeVoterToSlackChannel: Creating a new thread in this channel (${destinationSlackChannelId}), since voter hasn't been here.`
  );

  if (adminCommandParams) {
    userInfo.panelMessage = `routed from *${adminCommandParams.previousSlackChannelName}* by *${adminCommandParams.routingSlackUserName}*`;
  }

  // Start new thread in the destination channel
  const blocks = await SlackBlockUtil.getVoterPanel(
    userInfo,
    twilioPhoneNumber
  );
  const response = await SlackApiUtil.sendMessage(blocks[0].text.text, {
    channel: destinationSlackChannelName,
    blocks: blocks,
  });

  if (!response) {
    throw new Error('Unable to send newParentMessageText as a Slack message');
  }

  // Remember the voter's thread in this channel.
  userInfo[response.data.channel] = response.data.ts;

  // Be able to identify phone number using NEW Slack channel identifying info.
  await RedisApiUtil.setHash(
    redisClient,
    `${response.data.channel}:${response.data.ts}`,
    { userPhoneNumber, twilioPhoneNumber }
  );

  // Create the thread with the origin thread's need_attention status
  await DbApiUtil.logThreadToDb({
    slackParentMessageTs: response.data.ts,
    channelId: response.data.channel,
    userId: userInfo.userId,
    userPhoneNumber: userInfo.userPhoneNumber,
    twilioPhoneNumber: twilioPhoneNumber,
    needsAttention: needsAttention,
    isDemo: userInfo.isDemo,
    sessionStartEpoch: userInfo.sessionStartEpoch || null,
  });

  logger.debug(`ROUTER.routeVoterToSlackChannel: Voter is being routed to,
  destinationSlackChannelId: ${destinationSlackChannelId},
  destinationSlackParentMessageTs: ${response.data.ts},
  destinationSlackChannelName: ${destinationSlackChannelName}`);

  logger.debug(
    "ROUTER.routeVoterToSlackChannel: Changing voter's active channel."
  );
  // Reassign the active channel so that the next voter messages go to the
  // new active channel.
  userInfo.activeChannelId = response.data.channel;
  userInfo.activeChannelName = destinationSlackChannelName;

  // Update userInfo in Redis (remember state channel thread identifying info and new activeChannel).
  logger.debug(
    `ROUTER.routeVoterToSlackChannel: Writing updated userInfo to Redis.`
  );
  await RedisApiUtil.setHash(
    redisClient,
    `${userInfo.userId}:${twilioPhoneNumber}`,
    userInfo
  );

  // Populate state channel thread with message history so far.
  await postUserMessageHistoryToSlack(
    redisClient,
    userInfo,
    twilioPhoneNumber,
    {
      destinationSlackParentMessageTs: response.data.ts,
      destinationSlackChannelId: response.data.channel,
    }
  );

  await DbApiUtil.setThreadInactive(oldSlackParentMessageTs, oldChannelId);

  if (
    adminCommandParams &&
    adminCommandParams.commandChannel &&
    adminCommandParams.commandMessageTs
  ) {
    await SlackApiUtil.addSlackMessageReaction(
      adminCommandParams.commandChannel,
      adminCommandParams.commandMessageTs,
      'heavy_check_mark'
    );
  }
}

export async function recordVotedStatus(
  userInfo: UserInfo,
  twilioPhoneNumber: string
): Promise<void> {
  // Log the VOTED status
  await DbApiUtil.logVoterStatusToDb({
    userId: userInfo.userId,
    userPhoneNumber: userInfo.userPhoneNumber,
    twilioPhoneNumber: twilioPhoneNumber,
    isDemo: userInfo.isDemo,
    voterStatus: 'VOTED',
    originatingSlackUserName: null,
    originatingSlackUserId: null,
    slackChannelName: null,
    slackChannelId: null,
    slackParentMessageTs: null,
    actionTs: null,
  });
  await SlackApiUtil.sendMessage(
    `*Operator:* Voter status changed to *VOTED* by user text.`,
    {
      channel: userInfo.activeChannelId,
      parentMessageTs: userInfo[userInfo.activeChannelId],
    }
  );

  // Update voter status blocks
  const blocks = await SlackBlockUtil.getVoterPanel(
    userInfo,
    twilioPhoneNumber,
    undefined,
    'VOTED',
    undefined
  );
  await SlackInteractionApiUtil.replaceSlackMessageBlocks({
    slackChannelId: userInfo.activeChannelId,
    slackParentMessageTs: userInfo[userInfo.activeChannelId],
    newBlocks: blocks,
  });
}

export async function replyToVoted(
  userInfo: UserInfo,
  twilioPhoneNumber: string,
  twilioCallbackURL: string,
  userMessage: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry
): Promise<void> {
  // record the incoming user message
  await SlackApiUtil.sendMessage(
    userMessage,
    {
      parentMessageTs: userInfo[userInfo.activeChannelId],
      channel: userInfo.activeChannelId,
      isVoterMessage: true,
    },
    inboundDbMessageEntry,
    userInfo
  );
  const replyMessage = MessageConstants.VOTED_RESPONSE();
  await TwilioApiUtil.sendMessage(
    replyMessage,
    {
      userPhoneNumber: userInfo.userPhoneNumber,
      twilioPhoneNumber,
      twilioCallbackURL,
    },
    DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
  );
  await SlackApiUtil.sendMessage(replyMessage, {
    parentMessageTs: userInfo[userInfo.activeChannelId],
    channel: userInfo.activeChannelId,
    isAutomatedMessage: true,
  });
}

export async function determineVoterState(
  userOptions: UserOptions & { userInfo: UserInfo },
  redisClient: PromisifiedRedisClient,
  twilioPhoneNumber: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry,
  twilioCallbackURL: string
): Promise<void> {
  logger.debug('ENTERING ROUTER.determineVoterState');
  const userInfo = userOptions.userInfo;
  const userPhoneNumber = userOptions.userPhoneNumber;
  const userId = userInfo.userId;
  const userMessage = userOptions.userMessage;

  userInfo.numStateSelectionAttempts++;

  userInfo.lastVoterMessageSecsFromEpoch = Math.round(Date.now() / 1000);
  logger.debug(
    `ROUTER.determineVoterState: Updating lastVoterMessageSecsFromEpoch to ${userInfo.lastVoterMessageSecsFromEpoch}`
  );

  const lobbyChannelId = userInfo.activeChannelId;
  const lobbyParentMessageTs = userInfo[lobbyChannelId];

  logger.debug(
    `ROUTER.determineVoterState: Passing voter message to Slack, slackChannelName: ${lobbyChannelId}, parentMessageTs: ${lobbyParentMessageTs}.`
  );
  const blocks = SlackBlockUtil.formatMessageWithAttachmentLinks(
    userMessage,
    userOptions.userAttachments
  );
  await SlackApiUtil.sendMessage(
    '',
    {
      parentMessageTs: lobbyParentMessageTs,
      blocks,
      channel: lobbyChannelId,
      isVoterMessage: true,
    },
    inboundDbMessageEntry,
    userInfo
  );

  let stateName = StateParser.determineState(userMessage);

  if (stateName == null) {
    // If we've tried to determine their U.S. state enough times, choose the National channel
    // and let the voter know a volunteer is being sought.
    if (userInfo.numStateSelectionAttempts >= 2) {
      stateName = 'National';
      // Otherwise, try to determine their U.S. state one more time.
    } else {
      logger.debug(
        `ROUTER.determineVoterState: StateParser could not determine U.S. state of voter from message ${userMessage}`
      );

      await TwilioApiUtil.sendMessage(
        MessageConstants.CLARIFY_STATE(),
        { userPhoneNumber, twilioPhoneNumber, twilioCallbackURL },
        DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
      );
      await SlackApiUtil.sendMessage(MessageConstants.CLARIFY_STATE(), {
        parentMessageTs: lobbyParentMessageTs,
        channel: lobbyChannelId,
        isAutomatedMessage: true,
      });

      logger.debug(
        `ROUTER.determineVoterState: Writing updated userInfo to Redis.`
      );
      await RedisApiUtil.setHash(
        redisClient,
        `${userId}:${twilioPhoneNumber}`,
        userInfo
      );

      return;
    }
  }

  // This is used for display, DB logging, as well as to know later that the voter's
  // U.S. state has been determined.
  userInfo.stateName = stateName;
  logger.debug(
    `ROUTER.determineVoterState: StateParser reviewed ${userMessage} and determined U.S. state: ${stateName}`
  );

  const messageToVoter =
    userInfo.stateName === 'National'
      ? MessageConstants.FINDING_VOLUNTEER()
      : MessageConstants.STATE_CONFIRMATION(stateName);

  await TwilioApiUtil.sendMessage(
    messageToVoter,
    { userPhoneNumber, twilioPhoneNumber, twilioCallbackURL },
    DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
  );
  await SlackApiUtil.sendMessage(messageToVoter, {
    parentMessageTs: lobbyParentMessageTs,
    channel: lobbyChannelId,
    isAutomatedMessage: true,
  });

  let selectedStateChannelName = await LoadBalancer.selectSlackChannel(
    redisClient,
    LoadBalancer.PULL_ENTRY_POINT,
    stateName,
    userInfo.isDemo
  );

  if (!selectedStateChannelName) {
    selectedStateChannelName = userInfo.isDemo
      ? 'demo-national-0'
      : 'national-0';
    logger.error(
      `ROUTER.determineVoterState: ERROR in selecting U.S. state channel. Defaulting to ${selectedStateChannelName}.`
    );
  } else {
    logger.debug(
      `ROUTER.determineVoterState: U.S. state channel successfully selected: ${selectedStateChannelName}`
    );
  }

  await routeVoterToSlackChannel(userInfo, redisClient, {
    twilioPhoneNumber,
    destinationSlackChannelName: selectedStateChannelName,
  });
}

export async function clarifyHelplineRequest(
  userOptions: UserOptions & { userInfo: UserInfo },
  redisClient: PromisifiedRedisClient,
  twilioPhoneNumber: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry,
  twilioCallbackURL: string
): Promise<void> {
  logger.debug('ENTERING ROUTER.clarifyHelplineRequest');
  const userInfo = userOptions.userInfo;
  userInfo.lastVoterMessageSecsFromEpoch = Math.round(Date.now() / 1000);

  let messageToVoter = MessageConstants.CLARIFY_HELPLINE_REQUEST();

  if (isVotedKeyword(userOptions.userMessage)) {
    messageToVoter = MessageConstants.VOTED_WELCOME_RESPONSE();
    await DbApiUtil.logVoterStatusToDb({
      userId: userInfo.userId,
      userPhoneNumber: userInfo.userPhoneNumber,
      twilioPhoneNumber: twilioPhoneNumber,
      isDemo: userInfo.isDemo,
      voterStatus: 'VOTED',
      originatingSlackUserName: null,
      originatingSlackUserId: null,
      slackChannelName: null,
      slackChannelId: null,
      slackParentMessageTs: null,
      actionTs: null,
    });
  }

  await TwilioApiUtil.sendMessage(
    messageToVoter,
    {
      userPhoneNumber: userOptions.userPhoneNumber,
      twilioPhoneNumber,
      twilioCallbackURL,
    },
    DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
  );

  DbApiUtil.updateDbMessageEntryWithUserInfo(userInfo!, inboundDbMessageEntry);

  // The message isn't being relayed, so don't fill this field in Postgres.
  inboundDbMessageEntry.successfullySent = null;
  try {
    await DbApiUtil.logMessageToDb(inboundDbMessageEntry);
  } catch (error) {
    logger.info(
      `ROUTER.clarifyHelplineRequest: failed to log incoming voter message to DB`
    );
    Sentry.captureException(error);
  }

  // Update Redis Twilio-to-Slack lookup.
  logger.debug(
    `ROUTER.clarifyHelplineRequest: Updating voter userInfo in Redis.`
  );
  await RedisApiUtil.setHash(
    redisClient,
    `${userInfo.userId}:${twilioPhoneNumber}`,
    userInfo
  );
}

export async function handleDisclaimer(
  userOptions: UserOptions & { userInfo: UserInfo },
  redisClient: PromisifiedRedisClient,
  twilioPhoneNumber: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry,
  twilioCallbackURL: string
): Promise<void> {
  logger.debug('ENTERING ROUTER.handleDisclaimer');
  const userInfo = userOptions.userInfo;
  const userId = userInfo.userId;
  const userMessage = userOptions.userMessage;
  const slackLobbyMessageParams = {
    parentMessageTs: userInfo[userInfo.activeChannelId],
    channel: userInfo.activeChannelId,
  };

  logger.debug(
    `ROUTER.handleDisclaimer: Updating lastVoterMessageSecsFromEpoch to ${userInfo.lastVoterMessageSecsFromEpoch}`
  );
  userInfo.lastVoterMessageSecsFromEpoch = Math.round(Date.now() / 1000);

  const blocks = SlackBlockUtil.formatMessageWithAttachmentLinks(
    userMessage,
    userOptions.userAttachments
  );
  await SlackApiUtil.sendMessage(
    '',
    { ...slackLobbyMessageParams, blocks, isVoterMessage: true },
    inboundDbMessageEntry,
    userInfo
  );

  const userMessageNoPunctuation = userOptions.userMessage.replace(
    /[.,?/#!$%^&*;:{}=\-_`~()]/g,
    ''
  );
  const cleared = userMessageNoPunctuation.toLowerCase().trim() == 'agree';
  let automatedMessage;
  if (cleared) {
    logger.debug(
      `ROUTER.handleDisclaimer: Voter cleared disclaimer with message ${userMessage}.`
    );
    userInfo.confirmedDisclaimer = true;
    automatedMessage = MessageConstants.STATE_QUESTION();
  } else {
    logger.debug(
      `ROUTER.handleDisclaimer: Voter did not clear disclaimer with message ${userMessage}.`
    );
    automatedMessage = MessageConstants.CLARIFY_DISCLAIMER();
  }

  await RedisApiUtil.setHash(
    redisClient,
    `${userId}:${twilioPhoneNumber}`,
    userInfo
  );
  await TwilioApiUtil.sendMessage(
    automatedMessage,
    {
      userPhoneNumber: userOptions.userPhoneNumber,
      twilioPhoneNumber,
      twilioCallbackURL,
    },
    DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
  );
  await SlackApiUtil.sendMessage(automatedMessage, {
    ...slackLobbyMessageParams,
    isAutomatedMessage: true,
  });
}

export async function handleClearedVoter(
  userOptions: UserOptions & { userInfo: UserInfo },
  redisClient: PromisifiedRedisClient,
  twilioPhoneNumber: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry,
  twilioCallbackURL: string
): Promise<void> {
  logger.debug('ENTERING ROUTER.handleClearedVoter');
  const userInfo = userOptions.userInfo;
  const userId = userInfo.userId;
  const activeChannelMessageParams = {
    parentMessageTs: userInfo[userInfo.activeChannelId],
    channel: userInfo.activeChannelId,
  };

  const nowSecondsEpoch = Math.round(Date.now() / 1000);
  // Remember the lastVoterMessageSecsFromEpoch, for use in calculation below.
  const lastVoterMessageSecsFromEpoch = userInfo.lastVoterMessageSecsFromEpoch;
  // Update the lastVoterMessageSecsFromEpoch, for use in DB write below.
  userInfo.lastVoterMessageSecsFromEpoch = nowSecondsEpoch;

  const blocks = SlackBlockUtil.formatMessageWithAttachmentLinks(
    userOptions.userMessage,
    userOptions.userAttachments
  );

  await SlackApiUtil.sendMessage(
    '',
    {
      ...activeChannelMessageParams,
      blocks,
      isVoterMessage: true,
    },
    inboundDbMessageEntry,
    userInfo
  );

  // Update thread needs attention status -> true
  await DbApiUtil.setThreadNeedsAttentionToDb(
    userInfo[userInfo.activeChannelId],
    userInfo.activeChannelId,
    true
  );

  logger.debug(
    `ROUTER.handleClearedVoter: Seconds since last message from voter: ${
      nowSecondsEpoch - lastVoterMessageSecsFromEpoch
    }`
  );

  if (
    nowSecondsEpoch - lastVoterMessageSecsFromEpoch >
    MINS_BEFORE_WELCOME_BACK_MESSAGE * 60
  ) {
    logger.debug(
      `ROUTER.handleClearedVoter: Seconds since last message from voter > MINS_BEFORE_WELCOME_BACK_MESSAGE (${
        nowSecondsEpoch - lastVoterMessageSecsFromEpoch
      } > : ${MINS_BEFORE_WELCOME_BACK_MESSAGE}), sending welcome back message.`
    );
    let userMessage = null as string | null;
    if (isVotedKeyword(userOptions.userMessage)) {
      userMessage = MessageConstants.VOTED_RESPONSE();
    } else {
      userMessage = MessageConstants.WELCOME_BACK();
    }
    await TwilioApiUtil.sendMessage(
      userMessage,
      {
        userPhoneNumber: userOptions.userPhoneNumber,
        twilioPhoneNumber,
        twilioCallbackURL,
      },
      DbApiUtil.populateAutomatedDbMessageEntry(userInfo)
    );
    await SlackApiUtil.sendMessage(userMessage, {
      ...activeChannelMessageParams,
      isAutomatedMessage: true,
    });
  }

  logger.debug(`ROUTER.handleClearedVoter: Writing updated userInfo to Redis.`);
  await RedisApiUtil.setHash(
    redisClient,
    `${userId}:${twilioPhoneNumber}`,
    userInfo
  );
}

export async function handleSlackThreadCommand(
  userInfo: UserInfo,
  message: string,
  redisClient: PromisifiedRedisClient,
  twilioPhoneNumber: string,
  reqBody: SlackEventRequestBody,
  originatingSlackUserName: string,
  twilioCallbackURL: string
): Promise<boolean> {
  // Not a command? (Messages to voters should not start with ! unlesss they are all !, like "!!!")
  if (message[0] != '!' || message.split('').every((char) => char === '!')) {
    return false;
  }

  // Commands are admin-only!
  if (!SlackApiUtil.isMemberOfAdminChannel(userInfo.userId)) {
    await SlackApiUtil.addSlackMessageReaction(
      reqBody.event.channel,
      reqBody.event.ts,
      'x'
    );
    return true;
  }

  if (message.startsWith('!route ')) {
    // Route a voter to another channel.
    const channel = message.substr('!route '.length);
    const slackChannelIds = await RedisApiUtil.getHash(
      redisClient,
      'slackPodChannelIds'
    );
    const slackChannelNames: Record<string, string> = {};
    for (const name in slackChannelIds) {
      slackChannelNames[slackChannelIds[name]] = name;
    }
    // Mark that a volunteer has engaged (by routing them!)
    userInfo.volunteerEngaged = true;
    await routeVoterToSlackChannel(
      userInfo,
      redisClient,
      {
        twilioPhoneNumber: twilioPhoneNumber,
        destinationSlackChannelName: channel,
      } as CommandUtil.ParsedCommandRouteVoter,
      {
        commandParentMessageTs: reqBody.event.thread_ts,
        commandChannel: reqBody.event.channel,
        commandMessageTs: reqBody.event.ts,
        previousSlackChannelName: slackChannelNames[reqBody.event.channel],
        routingSlackUserName: originatingSlackUserName,
      }
    );
    return true;
  }

  if (message.startsWith('!state ')) {
    const arg = message.substr('!state '.length);
    const stateName = StateParser.determineState(arg);
    if (!stateName) {
      await SlackApiUtil.sendMessage(
        `*Operator:* Unrecognized state '${arg}'`,
        {
          parentMessageTs: reqBody.event.thread_ts,
          channel: reqBody.event.channel,
        }
      );
      await SlackApiUtil.addSlackMessageReaction(
        reqBody.event.channel,
        reqBody.event.ts,
        'x'
      );
      return true;
    }
    const slackChannelName = await LoadBalancer.selectSlackChannel(
      redisClient,
      LoadBalancer.PULL_ENTRY_POINT,
      stateName,
      userInfo.isDemo
    );
    if (!slackChannelName) {
      await SlackApiUtil.sendMessage(
        `*Operator:* No frontline channel for '${stateName}'`,
        {
          parentMessageTs: reqBody.event.thread_ts,
          channel: reqBody.event.channel,
        }
      );
      await SlackApiUtil.addSlackMessageReaction(
        reqBody.event.channel,
        reqBody.event.ts,
        'x'
      );
      return true;
    }

    const slackChannelIds = await RedisApiUtil.getHash(
      redisClient,
      'slackPodChannelIds'
    );
    const slackChannelNames: Record<string, string> = {};
    for (const name in slackChannelIds) {
      slackChannelNames[slackChannelIds[name]] = name;
    }

    userInfo.stateName = stateName;
    userInfo.volunteerEngaged = true; // Mark that a volunteer has engaged (by routing them!)
    await routeVoterToSlackChannel(
      userInfo,
      redisClient,
      {
        twilioPhoneNumber: twilioPhoneNumber,
        destinationSlackChannelName: slackChannelName,
      } as CommandUtil.ParsedCommandRouteVoter,
      {
        commandParentMessageTs: reqBody.event.thread_ts,
        commandChannel: reqBody.event.channel,
        commandMessageTs: reqBody.event.ts,
        previousSlackChannelName: slackChannelNames[reqBody.event.channel],
        routingSlackUserName: originatingSlackUserName,
      }
    );
    return true;
  }

  if (message === '!fake-old-session') {
    // This simulates the situation of a pre-2020 thread that has no sessionStartEpoch value.
    await RedisApiUtil.deleteHashField(
      redisClient,
      `${userInfo.userId}:${twilioPhoneNumber}`,
      'sessionStartEpoch'
    );
    await SlackApiUtil.addSlackMessageReaction(
      reqBody.event.channel,
      reqBody.event.ts,
      'white_check_mark'
    );
    return true;
  }

  if (message === '!resume-session') {
    // Continue a stale session in the existing thread.
    // NOTE: right now we only handle the "no session start epoch" cause for stale-ness
    if (userInfo.sessionStartEpoch) {
      await SlackApiUtil.addSlackMessageReaction(
        reqBody.event.channel,
        reqBody.event.ts,
        'x'
      );
      return true;
    }
    const oldest = await DbApiUtil.getCurrentSessionOldestMessageEpoch(
      userInfo.userId,
      twilioPhoneNumber
    );
    if (!oldest) {
      await SlackApiUtil.sendMessage(
        '*Operator:* Unable to identify start of session',
        {
          parentMessageTs: reqBody.event.thread_ts,
          channel: reqBody.event.channel,
        }
      );
      await SlackApiUtil.addSlackMessageReaction(
        reqBody.event.channel,
        reqBody.event.ts,
        'x'
      );
      return true;
    }
    userInfo.sessionStartEpoch = oldest;

    // Refresh the voter blocks
    const blocks = await SlackBlockUtil.getVoterPanel(
      userInfo,
      twilioPhoneNumber
    );
    await SlackInteractionApiUtil.replaceSlackMessageBlocks({
      slackChannelId: userInfo.activeChannelId,
      slackParentMessageTs: userInfo[userInfo.activeChannelId],
      newBlocks: blocks,
    });

    await RedisApiUtil.setHash(
      redisClient,
      `${userInfo.userId}:${twilioPhoneNumber}`,
      userInfo
    );
    await SlackApiUtil.sendMessage(
      '*Operator:* This session is no longer stale',
      {
        parentMessageTs: reqBody.event.thread_ts,
        channel: reqBody.event.channel,
      }
    );
    return true;
  }

  if (message.startsWith('!new-session ') || message === '!new-session') {
    // Open a new session + thread for this voter.
    let channel = userInfo.activeChannelName;
    if (message !== '!new-session') {
      channel = message.substr('!new-session '.length);
    }

    // Make sure the destination channel exists before we end their old session!
    const slackChannelIds = await RedisApiUtil.getHash(
      redisClient,
      'slackPodChannelIds'
    );
    if (!(channel in slackChannelIds)) {
      await SlackApiUtil.sendMessage(
        `*Operator:* Channel ${channel} does not exist`,
        {
          parentMessageTs: reqBody.event.thread_ts,
          channel: reqBody.event.channel,
        }
      );
      await SlackApiUtil.addSlackMessageReaction(
        reqBody.event.channel,
        reqBody.event.ts,
        'x'
      );
      return true;
    }

    // End old session, and then reintroduce them in the new channel
    await endVoterSession(redisClient, userInfo, twilioPhoneNumber);
    userInfo.sessionStartEpoch = Math.round(Date.now() / 1000);
    userInfo.volunteerEngaged = false;
    userInfo.numStateSelectionAttempts = 0;
    userInfo.returningVoter = true;
    const ts = await introduceNewVoterToSlackChannel(
      {
        userInfo: userInfo as UserInfo,
        userMessage: '',
        userAttachments: [],
      },
      redisClient,
      twilioPhoneNumber,
      null,
      'PULL',
      channel,
      twilioCallbackURL,
      false,
      true /* noWelcome */
    );
    if (ts) {
      // Link to the new session's thread from the old thread.
      const slackChannelIds = await RedisApiUtil.getHash(
        redisClient,
        'slackPodChannelIds'
      );
      const url = await SlackApiUtil.getThreadPermalink(
        slackChannelIds[channel],
        ts
      );
      await SlackApiUtil.sendMessage(
        `*Operator:* New session created: <${url}|Open>`,
        {
          parentMessageTs: reqBody.event.thread_ts,
          channel: reqBody.event.channel,
        }
      );
    }
    return true;
  }

  // Unrecognized command
  await SlackApiUtil.addSlackMessageReaction(
    reqBody.event.channel,
    reqBody.event.ts,
    'x'
  );
  await SlackApiUtil.sendMessage(
    '*Operator:* Unrecognized command (messages to voters should not start with `!`)',
    {
      parentMessageTs: reqBody.event.thread_ts,
      channel: reqBody.event.channel,
    }
  );
  return true;
}

export async function handleSlackVoterThreadMessage(
  reqBody: SlackEventRequestBody,
  redisClient: PromisifiedRedisClient,
  redisData: UserInfo,
  originatingSlackUserName: string,
  twilioCallbackURL: string,
  {
    retryCount,
    retryReason,
  }: { retryCount: number | undefined; retryReason: string | undefined }
): Promise<void> {
  logger.debug('ENTERING ROUTER.handleSlackVoterThreadMessage');
  const userPhoneNumber = redisData.userPhoneNumber;
  const twilioPhoneNumber = redisData.twilioPhoneNumber;
  if (!userPhoneNumber) {
    return;
  }

  logger.debug(
    `ROUTER.handleSlackVoterThreadMessage: Successfully determined userPhoneNumber from Redis`
  );
  const unprocessedSlackMessage = reqBody.event.text;
  logger.debug(
    `Received message from Slack (channel ${reqBody.event.channel} ts ${reqBody.event.ts}): ${unprocessedSlackMessage}`
  );

  // If the message doesn't need processing.
  let messageToSend = unprocessedSlackMessage;
  let unprocessedMessageToLog = null;
  const processedSlackMessage = MessageParser.processMessageText(
    unprocessedSlackMessage
  );
  // If the message did need processing.
  if (processedSlackMessage != null) {
    messageToSend = processedSlackMessage;
    unprocessedMessageToLog = unprocessedSlackMessage;
  }

  const MD5 = new Hashes.MD5();
  const userId = MD5.hex(userPhoneNumber);

  const outboundDbMessageEntry = DbApiUtil.populateIncomingDbMessageSlackEntry({
    originatingSlackUserName,
    originatingSlackUserId: reqBody.event.user,
    slackChannel: reqBody.event.channel,
    slackParentMessageTs: reqBody.event.thread_ts,
    slackMessageTs: reqBody.event.ts,
    unprocessedMessage: unprocessedMessageToLog,
    slackRetryNum: retryCount,
    slackRetryReason: retryReason,
  });
  outboundDbMessageEntry.slackFiles = reqBody.event.files;

  // check attachments
  if (reqBody.event.files) {
    let errors = MessageParser.validateSlackAttachments(reqBody.event.files);
    if (!errors.length) {
      errors = await SlackApiUtil.makeFilesPublic(reqBody.event.files);
    }
    if (errors.length) {
      await SlackApiUtil.sendMessage(
        'Sorry, there was a problem with one or more of your attachments:\n' +
          errors.map((x) => `>${x}`).join('\n'),
        {
          channel: reqBody.event.channel,
          parentMessageTs: reqBody.event.thread_ts,
        }
      );
      await SlackApiUtil.addSlackMessageReaction(
        reqBody.event.channel,
        reqBody.event.ts,
        'x'
      );
      return;
    }
  }

  const userInfo = (await RedisApiUtil.getHash(
    redisClient,
    `${userId}:${twilioPhoneNumber}`
  )) as UserInfo;
  // Only relay Slack messages from the active Slack thread.
  if (
    userInfo.activeChannelId === reqBody.event.channel &&
    userInfo[userInfo.activeChannelId] === reqBody.event.thread_ts
  ) {
    // is it a command?
    if (
      await handleSlackThreadCommand(
        userInfo,
        messageToSend,
        redisClient,
        twilioPhoneNumber,
        reqBody,
        originatingSlackUserName,
        twilioCallbackURL
      )
    ) {
      return;
    }

    // is this a stale thread?
    if (isStaleSession(userInfo)) {
      await SlackApiUtil.addSlackMessageReaction(
        reqBody.event.channel,
        reqBody.event.ts,
        'x'
      );
      await SlackApiUtil.sendMessage(
        '*Operator:* This helpline session is stale.\n`!resume-session` to resume\n`!new-session <channelname>` to open a fresh session in specified channel.',
        {
          parentMessageTs: reqBody.event.thread_ts,
          channel: reqBody.event.channel,
        }
      );
      return;
    }

    // relay!
    userInfo.lastVoterMessageSecsFromEpoch = Math.round(Date.now() / 1000);
    if (!userInfo.volunteerEngaged) {
      logger.debug('Router: volunteer engaged, suppressing automated system.');
      userInfo.volunteerEngaged = true;
    }
    await RedisApiUtil.setHash(
      redisClient,
      `${userId}:${twilioPhoneNumber}`,
      userInfo
    );
    await DbApiUtil.updateDbMessageEntryWithUserInfo(
      userInfo,
      outboundDbMessageEntry
    );

    await TwilioApiUtil.sendMessage(
      messageToSend,
      {
        userPhoneNumber,
        twilioPhoneNumber,
        twilioCallbackURL,
        deduplicationId: `${reqBody.event.channel}:${reqBody.event.ts}`,
      },
      outboundDbMessageEntry
    );

    // Update thread needs attention status -> false
    await DbApiUtil.setThreadNeedsAttentionToDb(
      userInfo[userInfo.activeChannelId],
      userInfo.activeChannelId,
      false
    );

    // Slack message is from inactive Slack thread.
  } else {
    if (userInfo.activeChannelId) {
      const ts = await DbApiUtil.getThreadLatestMessageTs(
        userInfo[userInfo.activeChannelId],
        userInfo.activeChannelId
      );
      const url = await SlackApiUtil.getThreadPermalink(
        userInfo.activeChannelId,
        ts || userInfo[userInfo.activeChannelId]
      );
      await SlackApiUtil.sendMessage(
        `*Operator:* Your message was not relayed, as this thread is inactive. The voter's active thread is in ${SlackApiUtil.linkToSlackChannel(
          userInfo.activeChannelId,
          userInfo.activeChannelName
        )} - <${url}|Open>`,
        {
          channel: reqBody.event.channel,
          parentMessageTs: reqBody.event.thread_ts,
        }
      );
    } else {
      await SlackApiUtil.sendMessage(
        `*Operator:* Your message was not relayed, as this thread is inactive. They have not reconnected to the helpline.`,
        {
          channel: reqBody.event.channel,
          parentMessageTs: reqBody.event.thread_ts,
        }
      );
    }
  }
}

export type SlackEventRequestBody = {
  event: {
    type: string;
    hidden: boolean;
    text: string;
    ts: string;
    thread_ts: string;
    user: string;
    channel: string;
    files?: SlackFile[];
  };
  authed_users: string[];
};

export async function handleSlackAdminCommand(
  reqBody: SlackEventRequestBody,
  redisClient: PromisifiedRedisClient,
  originatingSlackUserName: string
): Promise<void> {
  logger.debug(' ENTERING ROUTER.handleSlackAdminCommand');
  const adminCommandArgs = CommandUtil.parseSlackCommand(reqBody.event.text);
  logger.debug(
    `ROUTER.handleSlackAdminCommand: Parsed admin control command params: ${JSON.stringify(
      adminCommandArgs
    )}`
  );
  if (!adminCommandArgs) {
    await SlackApiUtil.sendMessage(
      `*Operator:* Your command could not be parsed (did you closely follow the required format)?`,
      {
        channel: process.env.ADMIN_CONTROL_ROOM_SLACK_CHANNEL_ID!,
        parentMessageTs: reqBody.event.ts,
      }
    );
    return;
  }

  switch (adminCommandArgs.command) {
    case CommandUtil.ROUTE_VOTER: {
      // TODO: Move some of this logic to CommandUtil, so this switch statement
      // is cleaner.
      const redisHashKey = `${adminCommandArgs.userId}:${adminCommandArgs.twilioPhoneNumber}`;
      logger.debug(
        `ROUTER.handleSlackAdminCommand: Looking up ${redisHashKey} in Redis.`
      );
      const userInfo = (await RedisApiUtil.getHash(
        redisClient,
        redisHashKey
      )) as UserInfo;

      // This catches invalid userPhoneNumber:twilioPhoneNumber pairs.
      if (!userInfo) {
        logger.debug(
          'Router.handleSlackAdminCommand: No Redis data found for userId:twilioPhoneNumber pair.'
        );
        await SlackApiUtil.sendMessage(
          `*Operator:* No record found for user ID (${adminCommandArgs.userId}) and/or Twilio phone number (${adminCommandArgs.twilioPhoneNumber}).`,
          {
            channel: process.env.ADMIN_CONTROL_ROOM_SLACK_CHANNEL_ID!,
            parentMessageTs: reqBody.event.ts,
          }
        );
        // userPhoneNumber:twilioPhoneNumber pair found successfully.
      } else {
        // Voter already in destination slack channel (error).
        if (
          userInfo.activeChannelName ===
          adminCommandArgs.destinationSlackChannelName
        ) {
          logger.debug(
            'Router.handleSlackAdminCommand: Voter is already active in destination Slack channel.'
          );
          await SlackApiUtil.sendMessage(
            `*Operator:* Voter's thread in ${userInfo.activeChannelName} is already the active thread.`,
            {
              channel: process.env.ADMIN_CONTROL_ROOM_SLACK_CHANNEL_ID!,
              parentMessageTs: reqBody.event.ts,
            }
          );
        } else {
          const adminCommandParams = {
            commandParentMessageTs: reqBody.event.ts,
            commandMessageTs: reqBody.event.ts,
            commandChannel: reqBody.event.channel,
            previousSlackChannelName: userInfo.activeChannelName,
            routingSlackUserName: originatingSlackUserName,
          };
          logger.debug(
            `Router.handleSlackAdminCommand: Routing voter from ${userInfo.activeChannelName} to ${adminCommandArgs.destinationSlackChannelName}.`
          );
          // Mark that a volunteer has engaged (by routing them!)
          userInfo.volunteerEngaged = true;
          await routeVoterToSlackChannel(
            userInfo,
            redisClient,
            adminCommandArgs,
            adminCommandParams
          );
        }
      }
      return;
    }
    case CommandUtil.FIND_VOTER:
      await CommandUtil.findVoter(
        redisClient,
        adminCommandArgs.voterIdentifier
      );
      return;
    case CommandUtil.RESET_VOTER:
      await CommandUtil.resetVoter(
        redisClient,
        adminCommandArgs.userId,
        adminCommandArgs.twilioPhoneNumber
      );
      return;
    default:
      logger.info(
        `ROUTER.handleSlackAdminCommand: Unknown Slack admin command`
      );
      return;
  }
}
