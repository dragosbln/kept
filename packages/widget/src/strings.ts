// Every customer-visible string in one table: the localization seam
// (multi-language is deferred) and the reviewable copy surface. Copy tone:
// honest about failure — "delivery unconfirmed" is a real state the product
// stands behind, not an apology for one.

export type UiStrings = {
  title: string;
  launcherLabel: string;
  launcherCloseLabel: string;
  closeLabel: string;
  startOverLabel: string;
  greeting: string;
  inputPlaceholder: string;
  inputLabel: string;
  sendLabel: string;
  thinkingLabel: string;
  deliveryFailed: string;
  deliveryUnknown: string;
  conversationLocked: string;
  turnFailed: string;
  conversationFullNotice: string;
  retryLabel: string;
  newConversationLabel: string;
  poweredBy: string;
};

export const DEFAULT_STRINGS: UiStrings = {
  title: 'Support',
  launcherLabel: 'Open support chat',
  launcherCloseLabel: 'Close support chat',
  closeLabel: 'Close chat',
  startOverLabel: 'Start over',
  greeting:
    'Hi! I can help with your order — delivery status, returns, and refunds. What can I do for you?',
  inputPlaceholder: 'Type your message…',
  inputLabel: 'Message',
  sendLabel: 'Send message',
  thinkingLabel: 'Working on a reply',
  deliveryFailed: 'Not delivered',
  deliveryUnknown: 'Delivery unconfirmed — this may or may not have gone through',
  conversationLocked: 'Your previous message is still being handled — try again in a moment',
  turnFailed: 'Something went wrong handling this message',
  conversationFullNotice: 'This conversation has reached its limit. Start a new one to continue.',
  retryLabel: 'Retry',
  newConversationLabel: 'Start a new conversation',
  poweredBy: 'Powered by Kept',
};
