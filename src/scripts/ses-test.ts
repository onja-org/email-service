/**
 * Sends one real email through SES, bypassing the queue, to verify AWS
 * credentials, identity verification and (in the sandbox) recipient verification.
 *
 *   AWS_REGION=eu-west-1 npm run ses:test -- --from no-reply@billing.example.com --to you@example.com
 *
 * Options:
 *   --from <address>        sender (its domain or address must be a verified SES identity)
 *   --to <address>[,<address>]  recipients (in the sandbox each must be a verified identity)
 *   --subject <text>        default "email-service test"
 *   --config-set <name>     optional SES configuration set (e.g. emailsvc-billing)
 *   --region <region>       default AWS_REGION
 *   --dry                   run the preflight checks only, send nothing
 */
import {
  GetAccountCommand,
  GetEmailIdentityCommand,
  SendEmailCommand,
  SESv2Client,
  SESv2ServiceException,
} from '@aws-sdk/client-sesv2';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const region = arg('region') ?? process.env.AWS_REGION;
const from = arg('from');
const to = (arg('to') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const subject = arg('subject') ?? 'email-service test';
const configSet = arg('config-set');

if (!region || !from || to.length === 0) {
  console.error('usage: npm run ses:test -- --from <address> --to <address>[,<address>] [--region r] [--config-set name] [--dry]');
  process.exit(2);
}

const ses = new SESv2Client({ region });
const domainOf = (addr: string) => addr.slice(addr.lastIndexOf('@') + 1).toLowerCase();
const bare = (addr: string) => (addr.match(/<([^>]+)>/)?.[1] ?? addr).trim();

async function identityStatus(name: string): Promise<string> {
  try {
    const d = await ses.send(new GetEmailIdentityCommand({ EmailIdentity: name }));
    return d.VerifiedForSendingStatus ? 'verified' : `NOT verified (dkim ${d.DkimAttributes?.Status ?? 'n/a'})`;
  } catch (err) {
    if (err instanceof SESv2ServiceException && err.name === 'NotFoundException') return 'not an SES identity';
    throw err;
  }
}

async function main() {
  console.log(`Region: ${region}`);
  const acct = await ses.send(new GetAccountCommand({}));
  const sandbox = !acct.ProductionAccessEnabled;
  console.log(`Account: ${sandbox ? 'SANDBOX' : 'production'}; sending ${acct.SendingEnabled ? 'enabled' : 'DISABLED'}; ` +
    `quota ${acct.SendQuota?.Max24HourSend}/day, ${acct.SendQuota?.MaxSendRate}/s; sent last 24h: ${acct.SendQuota?.SentLast24Hours}`);

  let ok = true;
  const fromAddr = bare(from!);
  const fromDomainStatus = await identityStatus(domainOf(fromAddr));
  const fromAddrStatus = fromDomainStatus === 'verified' ? 'covered by domain' : await identityStatus(fromAddr);
  console.log(`From ${fromAddr}: domain ${domainOf(fromAddr)} ${fromDomainStatus}; address ${fromAddrStatus}`);
  if (fromDomainStatus !== 'verified' && fromAddrStatus !== 'verified') { ok = false; console.log('  -> SES will reject: sender identity is not verified'); }

  for (const r of to) {
    const addr = bare(r);
    if (!sandbox) { console.log(`To ${addr}: production mode, any recipient allowed`); continue; }
    const dom = await identityStatus(domainOf(addr));
    const st = dom === 'verified' ? 'covered by verified domain' : await identityStatus(addr);
    console.log(`To ${addr}: ${st}`);
    if (!st.startsWith('verified') && !st.startsWith('covered')) {
      ok = false;
      console.log('  -> sandbox will reject: verify this address in SES (Identities > Create identity > Email address) and click the link SES emails to it');
    }
  }

  if (!ok) { console.log('\nPreflight failed; not sending.'); process.exit(1); }
  if (flag('dry')) { console.log('\nPreflight passed (--dry: nothing sent).'); return; }

  const out = await ses.send(new SendEmailCommand({
    FromEmailAddress: from,
    Destination: { ToAddresses: to },
    ConfigurationSetName: configSet,
    EmailTags: [{ Name: 'emailsvc_project', Value: 'ses-test' }],
    Content: {
      Simple: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: {
          Text: { Data: `This is a test from email-service.\nRegion: ${region}\nSent: ${new Date().toISOString()}`, Charset: 'UTF-8' },
          Html: { Data: `<p>This is a test from <b>email-service</b>.</p><p>Region: ${region}<br>Sent: ${new Date().toISOString()}</p>`, Charset: 'UTF-8' },
        },
      },
    },
  }));
  console.log(`\nSent. SES MessageId: ${out.MessageId}`);
  console.log('Check the inbox (and spam folder). Headers should show DKIM=pass for the sender domain.');
}

main().catch((err) => {
  if (err instanceof SESv2ServiceException) console.error(`${err.name}: ${err.message}`);
  else console.error(err);
  process.exit(1);
});
