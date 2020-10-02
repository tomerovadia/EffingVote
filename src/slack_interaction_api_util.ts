import axios from 'axios';
import { voterStatusPanel, SlackBlock } from './slack_block_util';
import logger from './logger';
import { UserInfo } from './types';
import * as SlackApiUtil from './slack_api_util';
import * as SlackInteractionHandler from './slack_interaction_handler';
import { PromisifiedRedisClient } from './redis_client';

export async function replaceSlackMessageBlocks({
  slackChannelId,
  slackParentMessageTs,
  newBlocks,
}: {
  slackChannelId: string;
  slackParentMessageTs: number;
  newBlocks: SlackBlock[];
}): Promise<void> {
  logger.info('ENTERING SLACKINTERACTIONAPIUTIL.replaceSlackMessageBlocks');
  // Replace voter status panel with message.
  const response = await axios.post(
    'https://slack.com/api/chat.update',
    {
      'Content-Type': 'application/json',
      channel: slackChannelId,
      token: process.env.SLACK_BOT_ACCESS_TOKEN,
      ts: slackParentMessageTs,
      blocks: newBlocks,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.SLACK_BOT_ACCESS_TOKEN}`,
      },
    }
  );

  if (response.data.ok) {
    logger.info(
      `SLACKINTERACTIONAPIUTIL.replaceSlackMessageBlock: Successfully replaced Slack message block`
    );
  } else {
    logger.error(
      `SLACKINTERACTIONAPIUTIL.replaceSlackMessageBlock: ERROR in replacing Slack message block: ${response.data.error}`
    );
  }
}

export function addBackVoterStatusPanel({
  slackChannelId,
  slackParentMessageTs,
  oldBlocks,
}: {
  slackChannelId: string;
  slackParentMessageTs: number;
  oldBlocks: SlackBlock[];
}): Promise<void> {
  logger.info('ENTERING SLACKINTERACTIONAPIUTIL.addBackVoterStatusPanel');

  const voterInfoBlock = oldBlocks[0];
  const volunteerDropdownBlock = oldBlocks[1];
  const newBlocks = [voterInfoBlock, volunteerDropdownBlock];
  newBlocks.push(voterStatusPanel);

  return replaceSlackMessageBlocks({
    slackChannelId,
    slackParentMessageTs,
    newBlocks,
  });
}

// This function is used in app.js for automated refusals.
export async function handleAutomatedCollapseOfVoterStatusPanel({
  userInfo,
  redisClient,
  newVoterStatus,
  userPhoneNumber,
  twilioPhoneNumber,
}: {
  userInfo: UserInfo;
  redisClient: PromisifiedRedisClient;
  newVoterStatus: SlackInteractionHandler.VoterStatusUpdate;
  userPhoneNumber: string;
  twilioPhoneNumber: string;
}): Promise<void> {
  const messageBlocks = await SlackApiUtil.fetchSlackMessageBlocks(
    userInfo.activeChannelId,
    userInfo[userInfo.activeChannelId]
  );

  if (!messageBlocks) {
    throw new Error(
      `Could not get Slack blocks for known user ${userInfo.userId}`
    );
  }

  const payload = {
    automatedButtonSelection: true,
    message: {
      blocks: messageBlocks,
    },
    container: {
      thread_ts: userInfo[userInfo.activeChannelId],
    },
    channel: {
      id: userInfo.activeChannelId,
    },
    user: {
      id: null,
    },
  };

  await SlackInteractionHandler.handleVoterStatusUpdate({
    payload,
    selectedVoterStatus: newVoterStatus,
    originatingSlackUserName: 'AUTOMATED',
    slackChannelName: userInfo.activeChannelName,
    userPhoneNumber,
    twilioPhoneNumber,
    redisClient,
  });
}
