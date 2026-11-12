/**
 * One-time AWS bootstrap. Idempotent: re-running reuses existing resources.
 *
 *   AWS_REGION=eu-west-1 WEBHOOK_URL=https://email.internal.example.com/webhooks/ses npm run setup:aws
 *
 * Creates:
 *   - SQS dead-letter queue  <prefix>-send-dlq
 *   - SQS send queue         <prefix>-send   (redrives to the DLQ after 5 receives)
 *   - SNS topic              <prefix>-events (SES event destinations publish here)
 *   - HTTPS subscription of WEBHOOK_URL to the topic (confirmed by the service itself)
 * Prints the env values to put in .env. Per-project SES configuration sets are
 * created by POST /admin/projects, and domain identities by POST /admin/projects/:slug/domains.
 */
import { CreateQueueCommand, GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import { CreateTopicCommand, ListSubscriptionsByTopicCommand, SNSClient, SubscribeCommand } from '@aws-sdk/client-sns';

const region = process.env.AWS_REGION;
if (!region) throw new Error('AWS_REGION is required');
const prefix = process.env.RESOURCE_PREFIX ?? 'emailsvc';
const webhookUrl = process.env.WEBHOOK_URL;

const sqs = new SQSClient({ region });
const sns = new SNSClient({ region });

async function createQueue(name: string, attrs: Record<string, string>) {
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: name, Attributes: attrs }));
  const { Attributes } = await sqs.send(
    new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }),
  );
  return { url: QueueUrl!, arn: Attributes!.QueueArn! };
}

async function main() {
  const dlq = await createQueue(`${prefix}-send-dlq`, { MessageRetentionPeriod: String(14 * 86400) });
  console.log(`DLQ:        ${dlq.url}`);

  const queue = await createQueue(`${prefix}-send`, {
    // Must exceed the worst-case time to call SES (a few seconds); the worker overrides it per retry.
    VisibilityTimeout: '60',
    ReceiveMessageWaitTimeSeconds: '20',
    MessageRetentionPeriod: String(4 * 86400),
    RedrivePolicy: JSON.stringify({ deadLetterTargetArn: dlq.arn, maxReceiveCount: 5 }),
  });
  console.log(`Queue:      ${queue.url}`);

  const { TopicArn } = await sns.send(new CreateTopicCommand({ Name: `${prefix}-events` }));
  console.log(`SNS topic:  ${TopicArn}`);

  if (webhookUrl) {
    await sns.send(new SubscribeCommand({ TopicArn, Protocol: 'https', Endpoint: webhookUrl }));
    console.log(`Subscribed: ${webhookUrl} (the running service confirms the subscription automatically)`);
  } else {
    console.log('WEBHOOK_URL not set: skipped SNS subscription. Re-run with it once the service is deployed.');
  }
  const { Subscriptions = [] } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }));
  if (Subscriptions.length) {
    console.log('Subscriptions on the topic (delete stale ones in the SNS console when the webhook URL changes):');
    for (const s of Subscriptions) console.log(`  ${s.Endpoint}  ${s.SubscriptionArn === 'PendingConfirmation' ? '(pending confirmation)' : ''}`);
  }

  console.log('\nAdd to your environment:\n');
  console.log(`AWS_REGION=${region}`);
  console.log(`SQS_QUEUE_URL=${queue.url}`);
  console.log(`SNS_EVENTS_TOPIC_ARN=${TopicArn}`);
  console.log('\nIf the account is still in the SES sandbox, request production access (SES > Account dashboard).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
