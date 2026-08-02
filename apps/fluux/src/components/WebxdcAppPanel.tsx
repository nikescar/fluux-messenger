import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useVirtualizer } from '@tanstack/react-virtual'
import { X, ArrowLeft, Package as PackageIcon, MoreVertical, Package } from 'lucide-react'
import { useWebxdcPanelStore, type WebxdcAppGroup, type WebxdcInstance } from '@/stores/webxdcPanelStore'
import { openWebxdcWindow } from '@/utils/webxdc/webxdcWindow'
import { formatUnreadCount } from '@/utils/formatUnreadCount'
import { Tooltip } from './Tooltip'

export interface WebxdcAppPanelProps {
  conversationId: string
  onClose: () => void
  fullScreen?: boolean
}

export function WebxdcAppPanel({ conversationId, onClose, fullScreen = false }: WebxdcAppPanelProps) {
  const { t } = useTranslation()
  const { getInstalledApps, getHideUpdateMessages, setHideUpdateMessages } = useWebxdcPanelStore()
  const hideUpdateMessages = getHideUpdateMessages(conversationId)

  const apps = getInstalledApps(conversationId)
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: apps.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 5,
  })


  return (
    <div className={`${fullScreen ? 'w-full h-full' : 'w-64 border-s border-fluux-bg'} flex flex-col bg-fluux-chat`}>
      {/* Panel header */}
      <div className="h-14 px-4 flex items-center justify-between border-b border-fluux-bg">
        {fullScreen ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
              aria-label={t('webxdc.back', 'Back')}
            >
              <ArrowLeft className="size-5 rtl-mirror" />
            </button>
            <h3 className="font-semibold text-fluux-text">{t('webxdc.apps', 'Webxdc Apps')}</h3>
          </div>
        ) : (
          <>
            <h3 className="font-semibold text-fluux-text">{t('webxdc.apps', 'Webxdc Apps')}</h3>
            <Tooltip content={t('webxdc.closePanel', 'Close panel')} position="left">
              <button
                type="button"
                onClick={onClose}
                aria-label={t('webxdc.closePanel', 'Close panel')}
                className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors tap-target"
              >
                <X className="size-4" />
              </button>
            </Tooltip>
          </>
        )}
      </div>

      {/* Hide update messages toggle */}
      <label className="flex items-center gap-2 px-4 py-2 border-b border-fluux-bg/50 text-sm text-fluux-muted cursor-pointer">
        <input
          type="checkbox"
          checked={hideUpdateMessages}
          onChange={(e) => setHideUpdateMessages(conversationId, e.target.checked)}
          className="size-4"
        />
        {t('webxdc.hideUpdateMessages', 'Hide update messages')}
      </label>

      {/* App list */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto">
        {apps.length === 0 ? (
          <div className="px-4 py-8 text-center">
            <PackageIcon className="size-12 mx-auto mb-3 text-fluux-muted/40" />
            <p className="text-sm font-medium text-fluux-text mb-1">
              {t('webxdc.noAppsInstalled', 'No installed apps')}
            </p>
            <p className="text-xs text-fluux-muted">
              {t('webxdc.installFromAttachments', 'Install apps from attachments in this conversation')}
            </p>
          </div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const group = apps[virtualRow.index]
              return (
                <div
                  key={virtualRow.key}
                  data-index={virtualRow.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <AppGroupItem
                    group={group}
                    conversationId={conversationId}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function AppGroupItem({
  group,
  conversationId,
}: {
  group: WebxdcAppGroup
  conversationId: string
}) {
  const { t } = useTranslation()
  const [menuOpen, setMenuOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [iconError, setIconError] = useState(false)

  const { removeApp, getAppGroupUnread } = useWebxdcPanelStore()

  const hasMultiple = group.instances.length > 1
  const groupUnreadCount = getAppGroupUnread(conversationId, group.appName)

  // Sort instances by last launched (most recent first)
  const sortedInstances = [...group.instances].sort((a, b) =>
    (b.lastLaunchedAt || b.installedAt) - (a.lastLaunchedAt || a.installedAt)
  )
  const mostRecentInstance = sortedInstances[0]
  const otherInstances = sortedInstances.slice(1)

  const handleOpenInstance = async (instance: WebxdcInstance) => {
    try {
      // Pass the instance's unique instanceId to ensure correct instance opens
      await openWebxdcWindow(instance.attachment, conversationId, instance.instanceId)
    } catch (error) {
      console.error('[webxdc] Failed to open instance:', error)
    }
  }

  const handleRemove = () => {
    setMenuOpen(false)
    removeApp(conversationId, group.appName)
  }

  return (
    <div className="px-4 py-2 border-b border-fluux-bg/50 relative">
      {/* Main clickable box */}
      <button
        type="button"
        onClick={() => handleOpenInstance(mostRecentInstance)}
        className="flex items-center gap-3 w-full hover:bg-fluux-hover/60 p-2 -m-2 rounded-lg transition-colors text-start"
      >
        {/* App icon with aggregate badge */}
        <div className="relative size-10 flex-shrink-0">
          <div className="size-full rounded-lg flex items-center justify-center bg-purple-500/20 text-purple-500 overflow-hidden">
            {group.icon && !iconError ? (
              <img
                src={group.icon}
                alt={group.appName}
                className="size-full object-cover"
                onError={() => setIconError(true)}
              />
            ) : (
              <PackageIcon className="size-5" />
            )}
          </div>
          {groupUnreadCount > 0 && (
            <span className="absolute -top-1 -end-1 z-10 min-w-4 h-4 px-1 bg-fluux-badge-strong text-white text-[10px] font-bold rounded-full flex items-center justify-center">
              {formatUnreadCount(groupUnreadCount)}
            </span>
          )}
        </div>

        {/* App name + date */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-fluux-text truncate">
              {group.appName}
            </span>
            {hasMultiple && (
              <span className="text-xs text-fluux-muted">
                ({group.instances.length})
              </span>
            )}
          </div>
          <span className="text-xs text-fluux-muted">
            {new Date(mostRecentInstance.messageTimestamp || mostRecentInstance.installedAt).toLocaleDateString()}
          </span>
        </div>
      </button>

      {/* Kebab menu - positioned absolutely to prevent event bubbling */}
      <div className="absolute top-2 right-2">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            setMenuOpen(!menuOpen)
          }}
          className="p-1 rounded hover:bg-fluux-hover text-fluux-muted hover:text-fluux-text transition-colors"
          aria-label={t('common.more', 'More')}
        >
          <MoreVertical className="size-4" />
        </button>

        {menuOpen && (
          <div className="absolute right-0 top-full mt-1 w-48 rounded-lg fluux-popover py-1 z-50">
            {hasMultiple && (
              <button
                type="button"
                onClick={() => {
                  setExpanded(!expanded)
                  setMenuOpen(false)
                }}
                className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-text hover:bg-fluux-hover transition-colors"
              >
                {t('webxdc.viewAll', 'View All')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setMenuOpen(false)
                handleRemove()
              }}
              className="flex w-full items-center gap-2.5 px-3 py-2 text-sm text-fluux-error hover:bg-fluux-hover transition-colors"
            >
              {t('webxdc.remove', 'Remove')}
            </button>
          </div>
        )}
      </div>

      {/* Expanded instances list */}
      {expanded && hasMultiple && (
        <div className="mt-2 space-y-1">
          {otherInstances.map(instance => (
            <InstanceItem
              key={instance.instanceId}
              instance={instance}
              onOpen={handleOpenInstance}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function InstanceItem({
  instance,
  onOpen
}: {
  instance: WebxdcInstance
  onOpen: (instance: WebxdcInstance) => void
}) {
  // Show message timestamp (when attachment was sent), fallback to install date
  const displayDate = new Date(instance.messageTimestamp || instance.installedAt).toLocaleDateString()

  return (
    <button
      type="button"
      onClick={() => onOpen(instance)}
      className="flex items-center gap-2 w-full p-2 hover:bg-fluux-hover/60 rounded-lg transition-colors"
    >
      <div className="relative size-8 flex-shrink-0">
        <div className="size-full rounded-lg flex items-center justify-center bg-purple-500/20 text-purple-500">
          <Package className="size-4" />
        </div>
        {instance.unreadCount > 0 && (
          <span className="absolute -top-1 -end-1 z-10 min-w-3 h-3 px-0.5 bg-fluux-badge-strong text-white text-[9px] font-bold rounded-full flex items-center justify-center">
            {formatUnreadCount(instance.unreadCount)}
          </span>
        )}
      </div>
      <span className="text-xs text-fluux-muted">{displayDate}</span>
    </button>
  )
}
