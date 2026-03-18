/**
 * Notification activities.
 *
 * In a real system these would send emails, push notifications, or webhook calls.
 * Here they log to stdout — the important thing is they demonstrate how Temporal
 * activities decouple side effects from workflow orchestration logic.
 */

import { log } from '@temporalio/activity';

/**
 * Notify a party with a message.
 * In production: replace with email/Slack/webhook call.
 */
export async function notifyParty(party: string, message: string): Promise<void> {
  const displayName = party.includes('::') ? party.split('::')[0] : party;
  const formatted = `[NOTIFICATION → ${displayName}]: ${message}`;
  log.info(formatted);
  console.log(formatted);
}
