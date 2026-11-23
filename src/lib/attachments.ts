import { badRequest } from './errors.js';

/** At most this many files per email. */
export const MAX_ATTACHMENTS = 10;
/** Total decoded size of all attachments on one email. Base64 makes the request ~1.37× this. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Extensions SES refuses to send (it rejects the whole message). Checked at the API
 * so the caller gets a 400 instead of an email that fails later in the worker.
 * Source: https://docs.aws.amazon.com/ses/latest/dg/mime-types.html
 */
const BLOCKED_EXTENSIONS = new Set(
  (
    'ade adp app asp bas bat cer chm cmd com cpl crt csh der exe fxp gadget hlp hta inf ins isp its js jse ksh ' +
    'lib lnk mad maf mag mam maq mar mas mat mau mav maw mda mdb mde mdt mdw mdz msc msh msh1 msh2 mshxml ' +
    'msh1xml msh2xml msi msp mst ops pcd pif plg prf prg reg scf scr sct shb shs sys ps1 ps1xml ps2 ps2xml ' +
    'psc1 psc2 tmp url vb vbe vbs vps vsmacros vss vst vsw vxd ws wsc wsf wsh xnk'
  ).split(' '),
);

/** Used when the caller omits content_type. Anything else is sent as application/octet-stream. */
const TYPES_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  csv: 'text/csv',
  html: 'text/html',
  ics: 'text/calendar',
  json: 'application/json',
  xml: 'application/xml',
  zip: 'application/zip',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  wav: 'audio/wav',
};

const TOKEN = "[A-Za-z0-9!#$&^_.+'-]+";
const CONTENT_TYPE_RE = new RegExp(`^${TOKEN}/${TOKEN}(\\s*;\\s*${TOKEN}=(${TOKEN}|"[^"\\r\\n]*"))*$`);
const CONTENT_ID_RE = /^[A-Za-z0-9._@$+-]{1,100}$/;
const BASE64_RE = /^[A-Za-z0-9+/_-]+={0,2}$/;

export interface AttachmentInput {
  filename: string;
  /** Base64-encoded file content. */
  content: string;
  content_type?: string;
  /** Makes it an inline attachment, referenced from the HTML as <img src="cid:{content_id}">. */
  content_id?: string;
}

export interface PreparedAttachment {
  filename: string;
  contentType: string;
  contentId?: string;
  content: Buffer;
}

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot === -1 ? '' : filename.slice(dot + 1).toLowerCase();
}

/** Validates and decodes attachments. Pure; throws HttpError (400) on the first problem. */
export function prepareAttachments(inputs: AttachmentInput[] | undefined): PreparedAttachment[] {
  if (!inputs?.length) return [];
  if (inputs.length > MAX_ATTACHMENTS) {
    throw badRequest('too_many_attachments', `At most ${MAX_ATTACHMENTS} attachments per email`);
  }

  const seenIds = new Set<string>();
  let total = 0;
  return inputs.map((a, index) => {
    const fail = (message: string) =>
      badRequest('invalid_attachment', `Attachment ${index} ("${a.filename}"): ${message}`, { index, filename: a.filename });

    const filename = a.filename.trim();
    if (!filename || filename.length > 255 || /[\x00-\x1f\x7f/\\]/.test(filename)) {
      throw fail('filename must be 1-255 characters with no slashes or control characters');
    }
    const ext = extensionOf(filename);
    if (BLOCKED_EXTENSIONS.has(ext)) {
      throw badRequest(
        'blocked_attachment_type',
        `Attachment ${index} ("${filename}"): ".${ext}" files can't be sent (executables and scripts are blocked)`,
        { index, filename },
      );
    }

    let contentType = a.content_type?.trim();
    if (contentType) {
      if (!CONTENT_TYPE_RE.test(contentType)) throw fail(`"${contentType}" is not a valid MIME type`);
    } else {
      contentType = TYPES_BY_EXTENSION[ext] ?? 'application/octet-stream';
    }

    let contentId: string | undefined;
    if (a.content_id !== undefined) {
      contentId = a.content_id.trim().replace(/^<(.*)>$/, '$1');
      if (!CONTENT_ID_RE.test(contentId)) {
        throw fail('content_id must be 1-100 characters: letters, digits and . _ @ $ + -');
      }
      if (seenIds.has(contentId)) throw fail(`content_id "${contentId}" is used more than once`);
      seenIds.add(contentId);
    }

    if (/^data:/i.test(a.content)) {
      throw fail('content must be plain base64, not a data: URI (drop the "data:...;base64," prefix)');
    }
    const b64 = a.content.replace(/\s+/g, '');
    if (!b64 || !BASE64_RE.test(b64)) throw fail('content must be base64-encoded and non-empty');
    const content = Buffer.from(b64, 'base64');
    if (content.length === 0) throw fail('content decodes to an empty file');

    total += content.length;
    if (total > MAX_ATTACHMENT_BYTES) {
      throw badRequest(
        'attachments_too_large',
        `Attachments may total at most ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB (decoded)`,
      );
    }

    return { filename, contentType, contentId, content };
  });
}
