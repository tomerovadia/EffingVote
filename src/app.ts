import express from 'express';
import Hashes from 'jshashes';
import bodyParser from 'body-parser';
import * as Sentry from '@sentry/node';
import morgan from 'morgan';
import axios, { AxiosResponse } from 'axios';
import { Pool } from 'pg';

import * as SlackApiUtil from './slack_api_util';
import * as TwilioApiUtil from './twilio_api_util';
import * as Router from './router';
import * as DbApiUtil from './db_api_util';
import * as RedisApiUtil from './redis_api_util';
import * as LoadBalancer from './load_balancer';
import * as SlackUtil from './slack_util';
import * as TwilioUtil from './twilio_util';
import * as SlackInteractionApiUtil from './slack_interaction_api_util';
import logger from './logger';
import redisClient from './redis_client';
import { EntryPoint, Request, UserInfo } from './types';
import { enqueueBackgroundTask } from './async_jobs';

const app = express();

const rawBodySaver = (
  req: Request,
  res: express.Response,
  buf?: Buffer,
  encoding?: string
) => {
  if (buf && buf.length) {
    req.rawBody = buf.toString((encoding as BufferEncoding) || 'utf8');
  }
};

function runAsyncWrapper(
  callback: (
    req: Request,
    res: express.Response,
    next: express.NextFunction
  ) => Promise<any>
) {
  return function (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction
  ) {
    callback(req as Request, res, next).catch(next);
  };
}

app.use(Sentry.Handlers.requestHandler());
app.use(
  morgan('combined', {
    stream: {
      write: function (message) {
        logger.info(message);
      },
    },
  })
);

app.use(bodyParser.json({ verify: rawBodySaver }));
app.use(bodyParser.urlencoded({ verify: rawBodySaver, extended: false }));
app.use(
  bodyParser.raw({
    verify: rawBodySaver,
    type: function () {
      return true;
    },
  })
);

app.post(
  '/push',
  runAsyncWrapper(async (req: Request, res: express.Response) => {
    const TWILIO_PHONE_NUMBER = '+18557041009';
    const MESSAGE =
      'This is Voter Help Line! We sent you an absentee ballot request form. Did you receive it? Text STOP to stop messages. Msg & data rates may apply.';

    const redisUserPhoneNumbersKey = 'userPhoneNumbers';
    const userPhoneNumbers = await redisClient.lrangeAsync(
      redisUserPhoneNumbersKey,
      0,
      1000
    );

    if (!userPhoneNumbers) {
      logger.info('Could not read phone numbers from redis');
      return;
    }

    logger.info('userPhoneNumbers:');
    logger.info(userPhoneNumbers);
    let delay = 0;
    const INTERVAL_MILLISECONDS = 2000;
    for (const idx in userPhoneNumbers) {
      const userPhoneNumber = userPhoneNumbers[idx];
      logger.info(`Sending push message to phone number: ${userPhoneNumber}`);

      const MD5 = new Hashes.MD5();
      const userId = MD5.hex(userPhoneNumber);

      const dbMessageEntry: DbApiUtil.DatabaseMessageEntry = {
        direction: 'OUTBOUND',
        automated: true,
        userId,
        entryPoint: LoadBalancer.PUSH_ENTRY_POINT,
      };

      await new Promise((resolve) => {
        setTimeout(resolve, delay);
      });

      await TwilioApiUtil.sendMessage(
        MESSAGE,
        { twilioPhoneNumber: TWILIO_PHONE_NUMBER, userPhoneNumber },
        dbMessageEntry
      );

      delay += INTERVAL_MILLISECONDS;
    }

    res.sendStatus(200);
  })
);

export async function handleKnownVoterBlockLogic(
  userInfo: UserInfo,
  userMessage: string,
  userPhoneNumber: string,
  twilioPhoneNumber: string,
  inboundDbMessageEntry: DbApiUtil.DatabaseMessageEntry
): Promise<boolean> {
  logger.debug('ENTERING SERVER');
  // Outbound texts should be blocked if either:
  // 1. this current message is STOP, or
  // 2. a prior interaction set outbound texts to be blocked for this user.
  let outboundTextsBlocked = await RedisApiUtil.getHashField(
    redisClient,
    'slackBlockedUserPhoneNumbers',
    userPhoneNumber
  );

  if (userMessage.toLowerCase().trim() === 'stop') {
    logger.info(
      `SERVER.handleIncomingTwilioMessage: Received STOP text from phone number: ${userPhoneNumber}.`
    );
    // Check is necessary in case a previously seen voter doesn't have a Slack thread
    // and their 2nd+ message is STOP, in which case there's nothing to collapse.
    if ('activeChannelId' in userInfo) {
      // This function also handles adding the phone number to blocklists.
      await SlackInteractionApiUtil.handleAutomatedCollapseOfVoterStatusPanel({
        userInfo,
        redisClient,
        newVoterStatus: 'REFUSED',
        userPhoneNumber,
        twilioPhoneNumber,
      });
    } else {
      await RedisApiUtil.setHash(redisClient, 'slackBlockedUserPhoneNumbers', {
        [userPhoneNumber]: '1',
      });
    }
    outboundTextsBlocked = true;
  }

  // If outbound texts are prohibited to this user, we return --
  // but first, we relay the message to Slack if a thread exists for
  // this voter and we write to the DB.
  if (outboundTextsBlocked) {
    DbApiUtil.updateDbMessageEntryWithUserInfo(
      userInfo!,
      inboundDbMessageEntry
    );

    if ('activeChannelId' in userInfo) {
      // This includes a DB write of the message.
      await SlackApiUtil.sendMessage(
        `*${userInfo.userId.substring(0, 5)}:* ${userMessage}`,
        {
          parentMessageTs: userInfo[userInfo.activeChannelId],
          channel: userInfo.activeChannelId,
        },
        inboundDbMessageEntry,
        userInfo
      );
    } else {
      // The message isn't being relayed, so don't fill this field in Postgres.
      inboundDbMessageEntry.successfullySent = null;
      try {
        await DbApiUtil.logMessageToDb(inboundDbMessageEntry);
      } catch (error) {
        logger.info(
          `SERVER.handleIncomingTwilioMessage: failed to log incoming voter message to DB`
        );
        Sentry.captureException(error);
      }
    }
  }
  return outboundTextsBlocked;
}

const handleIncomingTwilioMessage = async (
  req: Request,
  entryPoint: EntryPoint
) => {
  logger.info('Entering SERVER.handleIncomingTwilioMessage');

  const userPhoneNumber = req.body.From;

  const inboundTextsBlocked = await RedisApiUtil.getHashField(
    redisClient,
    'twilioBlockedUserPhoneNumbers',
    userPhoneNumber
  );

  if (inboundTextsBlocked === '1') {
    logger.info(
      `SERVER.handleIncomingTwilioMessage: Received text from blocked phone number: ${userPhoneNumber}.`
    );
    return;
  }

  const twilioPhoneNumber = req.body.To;
  const userMessage = req.body.Body;
  const MD5 = new Hashes.MD5();
  const userId = MD5.hex(userPhoneNumber);
  logger.info(`SERVER.handleIncomingTwilioMessage: Receiving Twilio message from ${entryPoint} entry point voter,
                userPhoneNumber: ${userPhoneNumber},
                twilioPhoneNumber: ${twilioPhoneNumber},
                userMessage: ${userMessage},
                userId: ${userId}`);

  const inboundDbMessageEntry = DbApiUtil.populateIncomingDbMessageTwilioEntry({
    userMessage,
    userPhoneNumber,
    twilioPhoneNumber,
    twilioMessageSid: req.body.SmsMessageSid,
    entryPoint: LoadBalancer.PUSH_ENTRY_POINT,
  });

  const redisHashKey = `${userId}:${twilioPhoneNumber}`;

  logger.info(
    `SERVER.handleIncomingTwilioMessage (${userId}): Retrieving userInfo using redisHashKey: ${redisHashKey}`
  );

  const userInfo = (await RedisApiUtil.getHash(
    redisClient,
    redisHashKey
  )) as UserInfo;
  logger.info(
    `SERVER.handleIncomingTwilioMessage (${userId}): Successfully received Redis response for userInfo retrieval with redisHashKey ${redisHashKey}, userInfo: ${JSON.stringify(
      userInfo
    )}`
  );

  // Seen this voter before
  if (userInfo != null) {
    logger.info(
      `SERVER.handleIncomingTwilioMessage (${userId}): Voter is known to us (Redis returned userInfo for redisHashKey ${redisHashKey})`
    );

    const outboundTextsBlocked = await handleKnownVoterBlockLogic(
      userInfo,
      userMessage,
      userPhoneNumber,
      twilioPhoneNumber,
      inboundDbMessageEntry
    );
    if (outboundTextsBlocked) return;

    // Voter is known but has no Slack thread.
    // Context: Certain organizations require an extra step before a Slack
    // thread is created for a voter. In these cases we still record whether
    // we've seen voters, but we may not have an active channel for them.
    if (!('activeChannelId' in userInfo)) {
      logger.info(
        `SERVER.handleIncomingTwilioMessage (${userId}): Voter is known but doesn't have a Slack thread yet.`
      );
      if (process.env.CLIENT_ORGANIZATION === 'VOTE_AMERICA') {
        const userMessageNoPunctuation = userMessage.replace(
          /[.,?/#!$%^&*;:{}=\-_`~()]/g,
          ''
        );
        if (userMessageNoPunctuation.toLowerCase().trim() == 'helpline') {
          await Router.handleNewVoter(
            { userPhoneNumber, userMessage, userId },
            redisClient,
            twilioPhoneNumber,
            inboundDbMessageEntry,
            entryPoint
          );
          return;
        } else {
          await Router.clarifyHelplineRequest(
            { userInfo, userPhoneNumber, userMessage },
            redisClient,
            twilioPhoneNumber,
            inboundDbMessageEntry
          );
          return;
        }
      } else {
        // For other organizations, all known and unblocked voters should have a Slack thread.
        throw new Error(
          `Redis has a userInfo that unexpectedly doesn't have an activeChannelId (userId: ${userId}, twilioPhoneNumber: ${twilioPhoneNumber})`
        );
      }
    }

    // PUSH
    if (entryPoint === LoadBalancer.PUSH_ENTRY_POINT) {
      logger.info(
        `SERVER.handleIncomingTwilioMessage (${userId}): Skipping automated system since entrypoint is ${LoadBalancer.PUSH_ENTRY_POINT}.`
      );
      // Don't do dislcaimer or U.S. state checks for push voters.
      await Router.handleClearedVoter(
        { userInfo, userPhoneNumber, userMessage },
        redisClient,
        twilioPhoneNumber,
        inboundDbMessageEntry
      );
      // PULL
    } else if (
      userInfo.confirmedDisclaimer ||
      process.env.CLIENT_ORGANIZATION === 'VOTE_AMERICA'
    ) {
      logger.info(
        `SERVER.handleIncomingTwilioMessage (${userId}): Activating automated system since entrypoint is ${LoadBalancer.PULL_ENTRY_POINT}.`
      );
      logger.info(
        `SERVER.handleIncomingTwilioMessage (${userId}): Voter has previously confirmed the disclaimer, or one is not required for this organization.`
      );
      // Voter has a state determined. The U.S. state name is used for
      // operator messages as well as to know whether a U.S. state is known
      // for the voter. This may not be ideal (create separate bool?).
      // Turn off automated replies if:
      // 1. a volunteer has intervened, or
      // 2. we've asked for their U.S. state too many times.
      if (
        userInfo.stateName ||
        userInfo.volunteerEngaged ||
        userInfo.numStateSelectionAttempts >=
          Router.NUM_STATE_SELECTION_ATTEMPTS_LIMIT
      ) {
        logger.info(
          `SERVER.handleIncomingTwilioMessage (${userId}): Known U.S. state for voter (${userInfo.stateName}) or volunteer has engaged (${userInfo.volunteerEngaged}). Automated system no longer active.`
        );
        await Router.handleClearedVoter(
          { userInfo, userPhoneNumber, userMessage },
          redisClient,
          twilioPhoneNumber,
          inboundDbMessageEntry
        );
        // Voter has no state determined
      } else {
        logger.info(
          `SERVER.handleIncomingTwilioMessage (${userId}): U.S. state for voter is not known. Automated system will attempt to determine.`
        );
        await Router.determineVoterState(
          { userInfo, userPhoneNumber, userMessage },
          redisClient,
          twilioPhoneNumber,
          inboundDbMessageEntry
        );
      }
    } else {
      logger.info(
        `SERVER.handleIncomingTwilioMessage (${userId}): Activating automated system since entrypoint is ${LoadBalancer.PULL_ENTRY_POINT}`
      );
      logger.info(
        `SERVER.handleIncomingTwilioMessage (${userId}): Voter has NOT previously confirmed the disclaimer. Automated system will attempt to confirm.`
      );
      await Router.handleDisclaimer(
        { userInfo, userPhoneNumber, userMessage },
        redisClient,
        twilioPhoneNumber,
        inboundDbMessageEntry
      );
    }
    // This is the first time we're seeing this voter.
  } else {
    logger.info(
      `SERVER.handleIncomingTwilioMessage (${userId}): Voter is new to us (Redis returned no userInfo for redisHashKey ${redisHashKey})`
    );

    if (userMessage.toLowerCase().trim() === 'stop') {
      logger.info(
        `SERVER.handleIncomingTwilioMessage: Received STOP text from phone number: ${userPhoneNumber}.`
      );
      // Block volunteers or automated system from sending messages to this number in the future,
      // even though there is no thread from which volunteers could do so.
      await RedisApiUtil.setHash(redisClient, 'slackBlockedUserPhoneNumbers', {
        [userPhoneNumber]: '1',
      });
      // If the voter's first messsage to us is STOP, ignore any and all subsequent messages.
      await RedisApiUtil.setHash(redisClient, 'twilioBlockedUserPhoneNumbers', {
        [userPhoneNumber]: '1',
      });
      // Return so that there is no logging in PG, no Slack thread is created, and
      // no automated response is sent to the voter.
      return;
    }

    if (process.env.CLIENT_ORGANIZATION === 'VOTE_AMERICA') {
      await Router.welcomePotentialVoter(
        { userPhoneNumber, userMessage, userId },
        redisClient,
        twilioPhoneNumber,
        inboundDbMessageEntry,
        entryPoint
      );
    } else {
      await Router.handleNewVoter(
        { userPhoneNumber, userMessage, userId },
        redisClient,
        twilioPhoneNumber,
        inboundDbMessageEntry,
        entryPoint
      );
    }
  }
};

app.post(
  '/twilio-push',
  runAsyncWrapper(async (req, res) => {
    logger.info(
      '**************************************************************************************************'
    );
    logger.info(
      '******************************************************************************************************'
    );
    logger.info('Entering SERVER POST /twilio-push');

    if (TwilioUtil.passesAuth(req)) {
      logger.info('SERVER POST /twilio-push: Passes Twilio auth.');
      await handleIncomingTwilioMessage(req, LoadBalancer.PUSH_ENTRY_POINT);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.send();
    } else {
      logger.error(
        'SERVER POST /twilio-push: ERROR authenticating /twilio-push request is from Twilio.'
      );
      res.writeHead(401, { 'Content-Type': 'text/xml' });
      res.send();
    }
  })
);

app.post(
  '/twilio-pull',
  runAsyncWrapper(async (req, res) => {
    logger.info(
      '**************************************************************************************************'
    );
    logger.info(
      '******************************************************************************************************'
    );
    logger.info('Entering SERVER POST /twilio-pull');

    if (TwilioUtil.passesAuth(req)) {
      logger.info('SERVER POST /twilio-pull: Passes Twilio auth.');
      await handleIncomingTwilioMessage(req, LoadBalancer.PULL_ENTRY_POINT);
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      res.send();
    } else {
      logger.error(
        'SERVER POST /twilio-pull: ERROR authenticating /twilio-pull request is from Twilio.'
      );
      res.writeHead(401, { 'Content-Type': 'text/xml' });
      res.send();
    }
  })
);

app.post(
  '/slack',
  runAsyncWrapper(async (req, res) => {
    logger.info(
      '**************************************************************************************************'
    );
    logger.info(
      '******************************************************************************************************'
    );
    logger.info('Entering SERVER POST /slack');
    res.type('application/json');

    if (req.body.challenge) {
      logger.info(
        'SERVER POST /slack: Authenticating Slack bot event listener with Node server.'
      );
      // Authenticate Slack connection to Heroku.
      if (SlackApiUtil.authenticateConnectionToSlack(req.body.token)) {
        logger.info(
          'SERVER POST /slack: Slack-Node authentication successful.'
        );
        res.status(200).json({ challenge: req.body.challenge });
      } else {
        res.sendStatus(401);
      }

      return;
    }

    if (!SlackUtil.passesAuth(req)) {
      logger.error(
        'SERVER POST /slack: ERROR in authenticating /slack request is from Slack.'
      );
      res.sendStatus(401);
      return;
    }

    const reqBody = req.body;
    if (!reqBody || !reqBody.event) {
      logger.error(`SERVER POST /slack: Issue with Slack reqBody: ${reqBody}.`);
      return;
    }

    const retryCount = req.header('X-Slack-Retry-Num')
      ? Number(req.header('X-Slack-Retry-Num'))
      : undefined;

    const retryReason = req.header('X-Slack-Retry-Reason');

    // We do some first-order routing here to make sure this is an event we
    // actually care about -- we want to quickly ignore things like
    // messages from the bot itself, hidden events, etc.
    if (
      reqBody.event.type === 'message' &&
      reqBody.event.user != process.env.SLACK_BOT_USER_ID &&
      !reqBody.event.hidden
    ) {
      await enqueueBackgroundTask('slackMessageEventHandler', reqBody, {
        retryCount,
        retryReason,
      });
    } else if (
      reqBody.event.type === 'app_mention' &&
      // Require that the Slack bot be the (first) user mentioned.
      reqBody.authed_users[0] === process.env.SLACK_BOT_USER_ID &&
      !retryReason
    ) {
      await enqueueBackgroundTask('slackAppMentionEventHandler', reqBody);
    }

    res.sendStatus(200);
  })
);

app.post(
  '/slack-interactivity',
  runAsyncWrapper(async (req, res) => {
    logger.info(
      '**************************************************************************************************'
    );
    logger.info(
      '******************************************************************************************************'
    );
    logger.info('Entering SERVER POST /slack-interactivity');

    if (!SlackUtil.passesAuth(req)) {
      logger.error(
        'SERVER POST /slack-interactivity: ERROR in authenticating request is from Slack.'
      );
      res.sendStatus(401);
      return;
    }
    logger.info('SERVER POST /slack-interactivity: PASSES AUTH');

    // Sanity check
    if (!req.body || !req.body.payload) {
      logger.error(
        'SERVER POST /slack-interactivity: ERROR with req.body or req.body.payload.'
      );
      return;
    }

    const payload = JSON.parse(req.body.payload);

    await enqueueBackgroundTask('slackInteractivityHandler', payload);

    res.sendStatus(200);
  })
);

app.get(
  '/debug-sentry',
  runAsyncWrapper(async function mainHandler() {
    await new Promise((resolve) => setTimeout(resolve, 100));

    Sentry.captureException(new Error('Explicit sentry error'));
    throw new Error('My first Sentry error!');
  })
);

app.get(
  '/debug-success',
  runAsyncWrapper(async function mainHandler(req, res) {
    await new Promise((resolve) => setTimeout(resolve, 100));

    res.sendStatus(200);
  })
);

function testHTTP() {
  return new Promise<string>((resolve) => {
    logger.info('START testHTTP');
    setTimeout(() => {
      resolve('TIMEOUT');
    }, 3000);

    void axios
      .get('https://google.com')
      .then((res: AxiosResponse) => {
        logger.info('PASS testHttp', res.status);
        resolve('PASS');
      })
      .catch((err) => {
        logger.info('FAIL testHttp', err);
        resolve('FAIL');
      });
  });
}

function testRedis() {
  return new Promise<string>((resolve) => {
    logger.info('START testRedis');
    setTimeout(() => {
      resolve('TIMEOUT');
    }, 3000);

    void redisClient
      .pingAsync()
      .then((res: any) => {
        logger.info('PASS testRedis', res);
        resolve('PASS');
      })
      .catch((err: Error) => {
        logger.info('FAIL testRedis', err);
        resolve('FAIL');
      });
  });
}

function testPostgres() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.CONNECTION_POOL_MAX || 20),
  });

  return new Promise<string>((resolve) => {
    logger.info('START testPostgres');
    setTimeout(() => {
      resolve('TIMEOUT');
    }, 3000);

    void pool
      .connect()
      .then((client) => {
        return client.query('SELECT 1');
      })
      .then((res) => {
        logger.info('PASS testPostgres', res);
        resolve('PASS');
      })
      .catch((err) => {
        logger.info('FAIL testPostgres', err);
        resolve('FAIL');
      });
  });
}

app.get(
  '/debug-connect',
  runAsyncWrapper(async function mainHandler(
    req: Request,
    res: express.Response
  ) {
    const httpPromise = testHTTP();
    const redisPromise = testRedis();
    const pgPromise = testPostgres();

    res.json({
      http: await httpPromise,
      redis: await redisPromise,
      pg: await pgPromise,
    });
  })
);

app.use(Sentry.Handlers.errorHandler());

app.use(function (err: Error, req: express.Request, res: express.Response) {
  logger.error(err);
  res.sendStatus(500);
});

export { app };
