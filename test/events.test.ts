import { describe, expect, it } from 'vitest';
import { interpretSesEvent } from '../src/services/events.js';

const mail = { messageId: 'ses-123', tags: { emailsvc_message_id: ['11111111-1111-1111-1111-111111111111'] } };

describe('interpretSesEvent', () => {
  it('ignores a correlation tag that is not one of our ids', () => {
    const ev = interpretSesEvent({ eventType: 'Delivery', mail: { messageId: 'ses-1', tags: { emailsvc_message_id: ['not-a-uuid'] } } });
    expect(ev.taggedMessageId).toBeNull();
    expect(ev.sesMessageId).toBe('ses-1');
  });

  it('marks deliveries', () => {
    const it_ = interpretSesEvent({ eventType: 'Delivery', mail });
    expect(it_).toMatchObject({ type: 'Delivery', sesMessageId: 'ses-123', newStatus: 'delivered', suppress: [] });
    expect(it_.taggedMessageId).toBe('11111111-1111-1111-1111-111111111111');
  });

  it('suppresses recipients on permanent bounces only', () => {
    const permanent = interpretSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'General',
        bouncedRecipients: [{ emailAddress: 'Gone@Example.com', diagnosticCode: '550 no such user' }],
      },
    });
    expect(permanent.newStatus).toBe('bounced');
    expect(permanent.suppress).toEqual([
      { email: 'Gone@Example.com', reason: 'bounce', note: 'General: 550 no such user' },
    ]);

    const transient = interpretSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'full@example.com' }] },
    });
    expect(transient.newStatus).toBeNull();
    expect(transient.suppress).toEqual([]);
  });

  it('suppresses complainers', () => {
    const c = interpretSesEvent({
      eventType: 'Complaint',
      mail,
      complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'angry@example.com' }] },
    });
    expect(c.newStatus).toBe('complained');
    expect(c.suppress).toEqual([{ email: 'angry@example.com', reason: 'complaint', note: 'abuse' }]);
  });

  it('fails rejected messages and ignores informational events', () => {
    expect(interpretSesEvent({ eventType: 'Reject', mail }).newStatus).toBe('failed');
    expect(interpretSesEvent({ eventType: 'Send', mail }).newStatus).toBeNull();
    expect(interpretSesEvent({ eventType: 'Open', mail }).newStatus).toBeNull();
  });

  it('accepts the legacy notificationType field and missing mail block', () => {
    const it_ = interpretSesEvent({ notificationType: 'Delivery' });
    expect(it_).toMatchObject({ type: 'Delivery', sesMessageId: null, taggedMessageId: null, newStatus: 'delivered' });
  });
});
