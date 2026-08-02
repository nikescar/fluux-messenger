/**
 * MessageAttachments - Shared component for rendering file attachments in messages
 *
 * Used by both ChatView and RoomView to render image, video, audio,
 * text file previews, and document cards in a consistent way.
 */

import type { FileAttachment } from '@fluux/sdk'
import { canPreviewAsText, isWebxdcMimeType } from '@/utils/thumbnail'
import { TextFilePreview } from './TextFilePreview'
import {
  ImageAttachment,
  VideoAttachment,
  AudioAttachment,
  FileAttachmentCard,
  shouldShowFileCard,
} from './FileAttachments'
import { WebxdcAttachment } from './WebxdcAttachment'

interface MessageAttachmentsProps {
  attachment: FileAttachment | undefined
  /** Conversation this message belongs to — required so WebxdcAttachment can open the app against the right conversation. */
  conversationId: string
  /** Message timestamp - used by webxdc to track when instance was sent */
  messageTimestamp?: Date
  /** Called when media (images) finish loading - useful for scroll adjustment */
  onMediaLoad?: () => void
  /** Whether the parent message is selected (for gradient adaptation) */
  isSelected?: boolean
  /** Whether the parent message is hovered (for gradient adaptation) */
  isHovered?: boolean
  /** Whether the parent message is the local user's own (bypasses media-autoload deferral). */
  isOwnMessage?: boolean
}

/**
 * Renders all applicable attachment types for a message.
 * Each attachment component internally checks if it should render
 * based on the attachment's media type.
 */
export function MessageAttachments({ attachment, conversationId, messageTimestamp, onMediaLoad, isSelected, isHovered, isOwnMessage }: MessageAttachmentsProps) {
  if (!attachment) return null

  const canPreview = canPreviewAsText(attachment.mediaType, attachment.name)

  return (
    <>
      {/* Image attachment preview */}
      <ImageAttachment attachment={attachment} onLoad={onMediaLoad} isOwnMessage={isOwnMessage} />

      {/* Video attachment with inline player */}
      <VideoAttachment attachment={attachment} onLoad={onMediaLoad} isOwnMessage={isOwnMessage} />

      {/* Audio attachment with inline player */}
      <AudioAttachment attachment={attachment} isOwnMessage={isOwnMessage} />

      {/* Text file preview (code, markdown, json, etc.) */}
      {canPreview && <TextFilePreview attachment={attachment} isSelected={isSelected} isHovered={isHovered} isOwnMessage={isOwnMessage} />}

      {/* Webxdc app attachment */}
      {isWebxdcMimeType(attachment.mediaType, attachment.name) && (
        <WebxdcAttachment attachment={attachment} conversationId={conversationId} messageTimestamp={messageTimestamp} />
      )}

      {/* Document/file attachment card (PDF, Word, etc.) */}
      {shouldShowFileCard(attachment, canPreview) && (
        <FileAttachmentCard attachment={attachment} />
      )}
    </>
  )
}
