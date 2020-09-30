import logger from './logger';
import type { PromisifiedRedisClient } from './redis_client';

const fieldTypes: {
  [fieldName: string]: 'string' | 'boolean' | 'integer' | undefined;
} = {
  // Not necessary (is default)
  userId: 'string',
  isDemo: 'boolean',
  confirmedDisclaimer: 'boolean',
  volunteerEngaged: 'boolean',
  lastVoterMessageSecsFromEpoch: 'integer',
};

export function setHash(
  redisClient: PromisifiedRedisClient,
  key: string,
  hash: { [k: string]: string | number }
): Promise<void[]> {
  logger.debug(`ENTERING REDISAPIUTIL.setHash`);

  return Promise.all(
    Object.keys(hash).map((field) => {
      const value = hash[field];

      return redisClient.hsetAsync(key, field, value);
    })
  );
}

export async function getHash(
  redisClient: PromisifiedRedisClient,
  key: string
): Promise<{
  [k: string]: any;
}> {
  logger.debug(`ENTERING REDISAPIUTIL.getHash`);
  const hash: {
    [k: string]: any;
  } = await redisClient.hgetallAsync(key);
  if (hash != null) {
    for (const field in hash) {
      switch (fieldTypes[field]) {
        case 'boolean':
          hash[field] = hash[field] === 'true';
          break;
        case 'integer':
          hash[field] = parseInt(hash[field]);
          break;
        default:
          break;
      }
    }
  }

  return hash;
}

export async function getHashField(
  redisClient: PromisifiedRedisClient,
  key: string,
  field: string
): Promise<any> {
  logger.debug(`ENTERING REDISAPIUTIL.getHashField`);

  const value = await redisClient.hgetAsync(key, field);
  if (value != null) {
    switch (fieldTypes[field]) {
      case 'boolean':
        return value === 'true';
      case 'integer':
        return parseInt(value);
      default:
        return value;
    }
  }
}

export function deleteHashField(
  redisClient: PromisifiedRedisClient,
  key: string,
  field: string
): Promise<number> {
  logger.debug(`ENTERING REDISAPIUTIL.deleteHashField`);

  return redisClient.hdelAsync(key, field);
}
