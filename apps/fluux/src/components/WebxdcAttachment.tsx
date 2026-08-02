import { useState, useEffect, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import { Package, Loader2, ExternalLink } from 'lucide-react'
import type { FileAttachment } from '@fluux/sdk'
import { formatBytes } from '@/hooks'
import { invoke } from '@tauri-apps/api/core'
import { getInstanceId } from '@/utils/webxdc/instanceId'
import { openWebxdcWindow } from '@/utils/webxdc/webxdcWindow'
import { useWebxdcPanelStore } from '@/stores/webxdcPanelStore'
import { formatUnreadCount } from '@/utils/formatUnreadCount'
import { Tooltip } from './Tooltip'

interface WebxdcAttachmentProps {
  attachment: FileAttachment
  conversationId: string
  messageTimestamp?: Date
}

export function WebxdcAttachment({ attachment, conversationId, messageTimestamp }: WebxdcAttachmentProps) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [extracting, setExtracting] = useState(true)
  const [iconError, setIconError] = useState(false)

  const { manifestCache, cacheManifest, isInstalled, installApp, removeInstance, setPanelOpen, installations } = useWebxdcPanelStore()

  const instanceId = getInstanceId(conversationId, attachment.url)
  const installed = isInstalled(conversationId, instanceId)

  // Get cached manifest or use filename
  const cached = manifestCache.get(attachment.url)
  const displayName = cached?.name || attachment.name || 'Webxdc App'

  // Calculate total unreads for this attachment URL across all instances
  const attachmentUnreadCount = useMemo(() => {
    let total = 0
    for (const convData of installations.values()) {
      for (const group of convData.apps.values()) {
        for (const instance of group.instances) {
          if (instance.attachmentUrl === attachment.url) {
            total += instance.unreadCount
          }
        }
      }
    }
    return total
  }, [installations, attachment.url])
  const sha256 = cached?.sha256

  // Extract manifest on mount
  useEffect(() => {
    // Skip if already cached
    if (cached) {
      setExtracting(false)
      return
    }

    let cancelled = false

    async function extract() {
      try {
        // Extract manifest and compute hash in parallel
        const [manifestResult, hashResult] = await Promise.allSettled([
          invoke<{ name: string; icon?: string }>('webxdc_extract_manifest', {
            url: attachment.url,
            filename: attachment.name || 'app.xdc',
            decryptKey: attachment.encryption?.key,
            decryptIv: attachment.encryption?.iv,
          }),
          invoke<{ sha256: string }>('webxdc_compute_hash', {
            url: attachment.url,
            decryptKey: attachment.encryption?.key,
            decryptIv: attachment.encryption?.iv,
          }),
        ])

        if (cancelled) return

        const manifest = manifestResult.status === 'fulfilled'
          ? manifestResult.value
          : { name: attachment.name || 'Webxdc App' }

        const hash = hashResult.status === 'fulfilled'
          ? hashResult.value.sha256
          : ''

        // Cache result
        cacheManifest(attachment.url, {
          name: manifest.name,
          icon: manifest.icon,
          sha256: hash,
        })
      } catch (error) {
        console.error('[webxdc] Failed to extract manifest:', error)
        // Cache fallback
        cacheManifest(attachment.url, {
          name: attachment.name || 'Webxdc App',
          sha256: '',
        })
      } finally {
        if (!cancelled) {
          setExtracting(false)
        }
      }
    }

    void extract()

    return () => {
      cancelled = true
    }
  }, [attachment.url, attachment.name, attachment.encryption, cached, cacheManifest])

  const handleOpen = async () => {
    setBusy(true)
    try {
      await openWebxdcWindow(attachment, conversationId)
    } catch (error) {
      console.error('[webxdc] Failed to open app:', error)
    } finally {
      setBusy(false)
    }
  }

  const handleInstall = async () => {
    setBusy(true)
    try {
      // Pre-extract the app during installation to warm the cache
      // This makes the first open instant instead of waiting 10s for extraction
      await invoke('webxdc_extract', {
        url: attachment.url,
        instanceId,
        conversationId,
        filename: attachment.name || 'app.xdc',
        decryptKey: attachment.encryption?.key,
        decryptIv: attachment.encryption?.iv
      })

      installApp(conversationId, instanceId, attachment, messageTimestamp?.getTime())
      setPanelOpen(conversationId, true)
    } catch (error) {
      console.error('[webxdc] Failed to extract during install:', error)
      // Still install even if extraction fails - it will retry on open
      installApp(conversationId, instanceId, attachment, messageTimestamp?.getTime())
      setPanelOpen(conversationId, true)
    } finally {
      setBusy(false)
    }
  }

  const handleRemove = () => {
    removeInstance(conversationId, instanceId)
  }

  const virusTotalUrl = sha256
    ? `https://www.virustotal.com/gui/file/${sha256}/details`
    : null

  return (
    <div className="pt-2 max-w-sm">
      {/* App card */}
      <button
        type="button"
        onClick={installed ? handleOpen : undefined}
        disabled={busy || !installed}
        className={`flex items-center gap-3 p-3 w-full rounded-lg bg-fluux-bg/60 border border-fluux-border transition-colors text-start ${
          installed ? 'hover:bg-fluux-hover/60 cursor-pointer' : 'cursor-default'
        } ${busy ? 'opacity-70' : ''}`}
        tabIndex={installed ? 0 : -1}
      >
        <div className="relative size-10 rounded-lg flex items-center justify-center flex-shrink-0 bg-purple-500/20 text-purple-500 overflow-hidden">
          {busy || extracting ? (
            <Loader2 className="size-5 animate-spin" />
          ) : cached?.icon && !iconError ? (
            <img
              src={cached.icon}
              alt={displayName}
              className="size-full object-cover"
              onError={() => setIconError(true)}
            />
          ) : (
            <Package className="size-5" />
          )}
          {attachmentUnreadCount > 0 && (
            <span className="absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 bg-fluux-badge-strong text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {formatUnreadCount(attachmentUnreadCount)}
            </span>
          )}
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-fluux-text truncate">
            {displayName}
          </p>
          <p className="text-xs text-fluux-muted">
            {t('chat.webxdcApp')}
            {attachment.size && ` • ${formatBytes(attachment.size)}`}
          </p>
        </div>
      </button>

      {/* Actions: VirusTotal + Install/Remove */}
      <div className="flex items-center gap-3 mt-2 px-1">
        {/* VirusTotal link */}
        {virusTotalUrl ? (
          <a
            href={virusTotalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs text-fluux-muted hover:text-fluux-text transition-colors"
          >
            <ExternalLink className="size-3" />
            VirusTotal
          </a>
        ) : (
          <Tooltip content={t('webxdc.hashUnavailable', 'Hash unavailable')} position="top">
            <span className="flex items-center gap-1.5 text-xs text-fluux-muted/40 cursor-not-allowed">
              <ExternalLink className="size-3" />
              VirusTotal
            </span>
          </Tooltip>
        )}

        {/* Install / Remove button */}
        {installed ? (
          <button
            type="button"
            onClick={handleRemove}
            className="text-xs text-fluux-error hover:underline"
          >
            {t('webxdc.remove', 'Remove')}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleInstall}
            disabled={extracting}
            className="text-xs text-fluux-brand hover:underline disabled:opacity-50"
          >
            {extracting ? t('common.loading', 'Loading...') : t('webxdc.install', 'Install App')}
          </button>
        )}
      </div>
    </div>
  )
}
