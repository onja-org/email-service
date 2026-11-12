import { describe, expect, it } from 'vitest';
import { MessageRejected, SESv2ServiceException } from '@aws-sdk/client-sesv2';
import { classifySendError, SendError } from '../src/services/ses.js';

const meta = (httpStatusCode: number) => ({ $metadata: { httpStatusCode } });

describe('classifySendError', () => {
  it('retries throttling, 5xx, paused sending and the transient "not verified" rejection', () => {
    expect(classifySendError(new SESv2ServiceException({ name: 'TooManyRequestsException', $fault: 'client', ...meta(429) })).retryable).toBe(true);
    expect(classifySendError(new SESv2ServiceException({ name: 'InternalFailure', $fault: 'server', ...meta(500) })).retryable).toBe(true);
    expect(classifySendError(new SESv2ServiceException({ name: 'SendingPausedException', $fault: 'client', ...meta(400) })).retryable).toBe(true);
    const unverified = new MessageRejected({ message: 'Email address is not verified. The following identities failed the check in region US-EAST-1: x@example.com', ...meta(400) });
    expect(classifySendError(unverified)).toMatchObject({ retryable: true, code: 'MessageRejected' });
  });

  it('fails permanently on other rejections and 4xx errors', () => {
    expect(classifySendError(new MessageRejected({ message: 'Message contains a blocked attachment', ...meta(400) })).retryable).toBe(false);
    expect(classifySendError(new SESv2ServiceException({ name: 'BadRequestException', $fault: 'client', ...meta(400) })).retryable).toBe(false);
    expect(classifySendError(new SESv2ServiceException({ name: 'AccountSuspendedException', $fault: 'client', ...meta(400) })).retryable).toBe(false);
  });

  it('passes SendError through and treats unknown errors as transient', () => {
    const own = new SendError('x', false, 'custom');
    expect(classifySendError(own)).toBe(own);
    expect(classifySendError(new Error('socket hang up')).retryable).toBe(true);
  });
});
