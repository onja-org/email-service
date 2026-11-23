import { describe, expect, it } from 'vitest';
import { MAX_ATTACHMENT_BYTES, prepareAttachments } from '../src/lib/attachments.js';
import { HttpError } from '../src/lib/errors.js';
import { toSesAttachments } from '../src/services/ses.js';

const b64 = (s: string | Buffer) => Buffer.from(s).toString('base64');

function errorOf(fn: () => unknown): HttpError {
  try {
    fn();
  } catch (e) {
    if (e instanceof HttpError) return e;
    throw e;
  }
  throw new Error('expected an HttpError');
}

describe('prepareAttachments', () => {
  it('decodes content, infers content types and normalises content ids', () => {
    const out = prepareAttachments([
      { filename: 'Invoice 42.PDF', content: b64('%PDF') },
      { filename: 'logo.png', content: b64('png'), content_id: '<logo@acme>' },
      { filename: 'notes', content: b64('x') },
      { filename: 'report.csv', content: b64('a,b'), content_type: 'text/csv; charset=utf-8' },
    ]);
    expect(out.map((a) => [a.filename, a.contentType, a.contentId])).toEqual([
      ['Invoice 42.PDF', 'application/pdf', undefined],
      ['logo.png', 'image/png', 'logo@acme'],
      ['notes', 'application/octet-stream', undefined],
      ['report.csv', 'text/csv; charset=utf-8', undefined],
    ]);
    expect(out[0].content.toString()).toBe('%PDF');
  });

  it('accepts line-wrapped base64 and returns nothing for no attachments', () => {
    const wrapped = b64('hello world, this is a file').replace(/(.{8})/g, '$1\r\n');
    expect(prepareAttachments([{ filename: 'a.txt', content: wrapped }])[0].content.toString()).toBe(
      'hello world, this is a file',
    );
    expect(prepareAttachments(undefined)).toEqual([]);
    expect(prepareAttachments([])).toEqual([]);
  });

  it('rejects file types SES refuses to send', () => {
    for (const filename of ['setup.exe', 'run.BAT', 'script.js', 'x.ps1']) {
      const err = errorOf(() => prepareAttachments([{ filename, content: b64('x') }]));
      expect(err.code, filename).toBe('blocked_attachment_type');
      expect(err.statusCode).toBe(400);
    }
  });

  it('rejects malformed content, filenames, types and content ids', () => {
    const bad = (a: object) => errorOf(() => prepareAttachments([{ filename: 'a.txt', content: b64('x'), ...a }]));
    expect(bad({ content: 'data:text/plain;base64,eA==' }).message).toContain('data: URI');
    expect(bad({ content: 'not base64!' }).code).toBe('invalid_attachment');
    expect(bad({ content: '===' }).code).toBe('invalid_attachment');
    expect(bad({ filename: '../etc/passwd' }).code).toBe('invalid_attachment');
    expect(bad({ filename: 'a\r\nBcc: x.txt' }).code).toBe('invalid_attachment');
    expect(bad({ content_type: 'text/plain\r\nX: y' }).code).toBe('invalid_attachment');
    expect(bad({ content_type: 'pdf' }).code).toBe('invalid_attachment');
    expect(bad({ content_id: 'has space' }).code).toBe('invalid_attachment');
    const dup = errorOf(() =>
      prepareAttachments([
        { filename: 'a.png', content: b64('x'), content_id: 'logo' },
        { filename: 'b.png', content: b64('y'), content_id: 'logo' },
      ]),
    );
    expect(dup.details).toEqual({ index: 1, filename: 'b.png' });
  });

  it('enforces the count and total size limits', () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ filename: `f${i}.txt`, content: b64('x') }));
    expect(errorOf(() => prepareAttachments(many)).code).toBe('too_many_attachments');

    const half = b64(Buffer.alloc(MAX_ATTACHMENT_BYTES / 2 + 1));
    const err = errorOf(() =>
      prepareAttachments([
        { filename: 'a.bin', content: half },
        { filename: 'b.bin', content: half },
      ]),
    );
    expect(err.code).toBe('attachments_too_large');
  });
});

describe('toSesAttachments', () => {
  it('maps regular and inline attachments onto SESv2 fields', () => {
    const content = Buffer.from('x');
    expect(toSesAttachments(undefined)).toBeUndefined();
    expect(toSesAttachments([])).toBeUndefined();
    expect(
      toSesAttachments([
        { filename: 'a.pdf', contentType: 'application/pdf', content },
        { filename: 'logo.png', contentType: 'image/png', contentId: 'logo', content },
      ]),
    ).toEqual([
      { FileName: 'a.pdf', RawContent: content, ContentType: 'application/pdf', ContentTransferEncoding: 'BASE64', ContentDisposition: 'ATTACHMENT' },
      { FileName: 'logo.png', RawContent: content, ContentType: 'image/png', ContentTransferEncoding: 'BASE64', ContentDisposition: 'INLINE', ContentId: 'logo' },
    ]);
  });
});
