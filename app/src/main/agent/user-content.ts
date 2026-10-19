// Build the SDK user-message content from typed text + image attachments (#456).
// The linchpin of the feature (discovery R-1): images are sent to Claude as vision
// blocks. The return type is derived from the SHIPPED SDK's own content type
// (SDKUserMessage['message']['content']), so this file only compiles if the SDK
// actually accepts image blocks — the compile IS the R-1 guard. Pure/DOM-free →
// unit-testable; agent-manager calls it when pushing the user turn.
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

import type { MessageAttachmentInput } from '../../shared/ipc-contract'

type UserMessageContent = SDKUserMessage['message']['content']
type ContentBlock = Exclude<UserMessageContent, string>[number]
type ImageBlock = Extract<ContentBlock, { type: 'image' }>
type ImageMediaType = Extract<ImageBlock['source'], { type: 'base64' }>['media_type']

/**
 * `text` alone → a plain string (the exact pre-#456 behavior, unchanged for the
 * common no-attachment path). With attachments → a content-block array: the text
 * block first (when non-empty), then one base64 image block per attachment. Media
 * types are validated upstream (image-attachment.validateAttachment), so the cast to
 * the SDK's media_type union is sound.
 */
export function buildUserContent(
  text: string,
  attachments: readonly MessageAttachmentInput[] | undefined,
): UserMessageContent {
  if (!attachments || attachments.length === 0) {
    return text
  }
  const blocks: ContentBlock[] = []
  if (text.length > 0) {
    blocks.push({ type: 'text', text })
  }
  for (const attachment of attachments) {
    blocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: attachment.mediaType as ImageMediaType,
        data: attachment.dataBase64,
      },
    })
  }
  return blocks
}
