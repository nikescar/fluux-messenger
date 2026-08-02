/**
 * Generate unique instance identifier for a webxdc app.
 *
 * Instances are scoped by (conversationId, attachmentUrl) for internal storage,
 * but the XMPP <instance> element should use ONLY the URL for interoperability.
 *
 * This internal format allows:
 * - Same .xdc file in different chats = different game instances
 * - Extracting conversationId to know who to send updates to
 *
 * The XMPP bridge will extract just the URL portion when sending messages.
 *
 * @param conversationId - Bare JID for 1:1, room JID for group chat
 * @param attachmentUrl - HTTPS URL of the .xdc file
 * @returns Instance ID string (conversationId:attachmentUrl)
 */
export function getInstanceId(conversationId: string, attachmentUrl: string): string {
  return `${conversationId}:${attachmentUrl}`
}
