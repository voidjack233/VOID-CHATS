import { useEffect, useMemo, useRef, useState } from 'react';
import { FolderPlus, Hash, MoreHorizontal, Users } from 'lucide-react';
import {
  Conversation,
  ConversationCategory,
  createConversationCategory,
  getConversationCategories,
} from '../../../Services/Chat/chatService';
import CreateCategoryModal from './CreateCategoryModal';
import GroupChannelCategory from './GroupChannelCategory';
import GroupChannelListItem from './GroupChannelListItem';

interface GroupChannelsSidebarProps {
  conversation: Conversation;
  channels: Conversation[];
  activeChannelId: string;
  currentUserId: string;
  onSelectChannel: (channel: Conversation) => void;
  onOpenChannelSettings: (channel: Conversation) => void;
  onCreateChannel: (categoryId?: string | null) => void;
}

export default function GroupChannelsSidebar({
  conversation,
  channels,
  activeChannelId,
  currentUserId,
  onSelectChannel,
  onOpenChannelSettings,
  onCreateChannel,
}: GroupChannelsSidebarProps) {
  const MENU_WIDTH = 192;
  const MENU_HEIGHT = 108;
  const MENU_MARGIN = 8;
  const [categories, setCategories] = useState<ConversationCategory[]>([]);
  const [collapsedCategoryIds, setCollapsedCategoryIds] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [isHeaderMenuOpen, setIsHeaderMenuOpen] = useState(false);
  const [showCreateCategory, setShowCreateCategory] = useState(false);
  const sidebarRef = useRef<HTMLElement | null>(null);
  const openMenuTimeoutRef = useRef<number | null>(null);
  const canManageChannels = currentUserId === conversation.owner_id;

  useEffect(() => {
    let ignore = false;

    const loadCategories = async () => {
      try {
        const nextCategories = await getConversationCategories(conversation.public_id || conversation.id);
        if (ignore) return;

        setCategories(nextCategories);
        setCollapsedCategoryIds((prev) =>
          nextCategories.reduce<Record<string, boolean>>((acc, category) => {
            acc[category.id] = prev[category.id] ?? false;
            return acc;
          }, {})
        );
      } catch (err) {
        if (ignore) return;
        console.error('Failed to load group categories:', err);
        setCategories([]);
        setCollapsedCategoryIds({});
      }
    };

    void loadCategories();

    return () => {
      ignore = true;
    };
  }, [conversation.id]);

  const customCategories = useMemo(
    () =>
      categories
        .filter((category) => !category.is_default)
        .sort((a, b) => {
          if (a.position !== b.position) return a.position - b.position;
          return a.name.localeCompare(b.name);
        }),
    [categories]
  );

  const uncategorizedChannels = useMemo(() => {
    const customCategoryIds = new Set(customCategories.map((category) => category.id));
    return channels.filter((channel) => !channel.category_id || !customCategoryIds.has(channel.category_id));
  }, [channels, customCategories]);

  const channelCategories = useMemo(() => {
    const categoryMap = new Map(
      customCategories.map((category) => [
        category.id,
        {
          ...category,
          channels: [] as Conversation[],
          showCreateChannelButton: true,
        },
      ])
    );

    for (const channel of channels) {
      const targetCategory = channel.category_id ? categoryMap.get(channel.category_id) : null;
      if (targetCategory) {
        targetCategory.channels.push(channel);
      }
    }

    return customCategories.map((category) => ({
      ...category,
      channels: categoryMap.get(category.id)?.channels || [],
      showCreateChannelButton: true,
    }));
  }, [channels, customCategories]);

  useEffect(() => {
    setCollapsedCategoryIds((prev) =>
      channelCategories.reduce<Record<string, boolean>>((acc, category) => {
        acc[category.id] = prev[category.id] ?? false;
        return acc;
      }, {})
    );
  }, [channelCategories]);

  useEffect(() => {
    if (!contextMenu && !isHeaderMenuOpen) return;

    const closeMenu = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[data-group-sidebar-action="true"]')) {
        return;
      }
      setContextMenu(null);
      setIsHeaderMenuOpen(false);
    };

    const closeOnScroll = () => {
      setContextMenu(null);
      setIsHeaderMenuOpen(false);
    };
    const timer = window.setTimeout(() => {
      document.addEventListener('mousedown', closeMenu);
    }, 0);

    document.addEventListener('scroll', closeOnScroll, true);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('scroll', closeOnScroll, true);
    };
  }, [contextMenu, isHeaderMenuOpen]);

  useEffect(() => {
    return () => {
      if (openMenuTimeoutRef.current !== null) {
        window.clearTimeout(openMenuTimeoutRef.current);
      }
    };
  }, []);

  const toggleCategory = (categoryId: string) => {
    setCollapsedCategoryIds((prev) => ({
      ...prev,
      [categoryId]: !prev[categoryId],
    }));
  };

  const openCreateChannel = (categoryId?: string | null) => {
    const nextCategoryId = categoryId || null;
    onCreateChannel(nextCategoryId);
  };

  const openMenuAt = (x: number, y: number) => {
    setIsHeaderMenuOpen(false);

    const sidebarRect = sidebarRef.current?.getBoundingClientRect();
    const sidebarWidth = sidebarRect?.width || MENU_WIDTH + MENU_MARGIN * 2;
    const sidebarHeight = sidebarRect?.height || MENU_HEIGHT + MENU_MARGIN * 2;
    let nextX = sidebarRect ? x - sidebarRect.left : x;
    let nextY = sidebarRect ? y - sidebarRect.top : y;

    if (sidebarWidth - nextX < MENU_WIDTH + MENU_MARGIN) {
      nextX = sidebarWidth - MENU_WIDTH - MENU_MARGIN;
    }

    if (sidebarHeight - nextY < MENU_HEIGHT + MENU_MARGIN) {
      nextY = sidebarHeight - MENU_HEIGHT - MENU_MARGIN;
    }

    if (nextX < MENU_MARGIN) nextX = MENU_MARGIN;
    if (nextY < MENU_MARGIN) nextY = MENU_MARGIN;

    if (openMenuTimeoutRef.current !== null) {
      window.clearTimeout(openMenuTimeoutRef.current);
    }

    openMenuTimeoutRef.current = window.setTimeout(() => {
      setContextMenu({ x: nextX, y: nextY });
      openMenuTimeoutRef.current = null;
    }, 0);
  };

  const handleEmptySpaceContextMenu = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!canManageChannels) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('[data-group-sidebar-action="true"]')) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.nativeEvent.stopImmediatePropagation();
    openMenuAt(event.clientX, event.clientY);
  };

  const handleCreateCategory = async (name: string) => {
    const { category } = await createConversationCategory(conversation.public_id || conversation.id, name);
    setCategories((prev) =>
      [...prev, category].sort((a, b) => {
        if (a.is_default && !b.is_default) return -1;
        if (!a.is_default && b.is_default) return 1;
        if (a.position !== b.position) return a.position - b.position;
        return a.name.localeCompare(b.name);
      })
    );
    setCollapsedCategoryIds((prev) => ({
      ...prev,
      [category.id]: false,
    }));
  };

  const menuActions = (
    <>
      <button
        type="button"
        onClick={() => {
          setContextMenu(null);
          setIsHeaderMenuOpen(false);
          openCreateChannel(null);
        }}
        data-group-sidebar-action="true"
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover"
      >
        <Hash className="h-4 w-4 text-void-text-muted" />
        <span>Create Channel</span>
      </button>
      <button
        type="button"
        onClick={() => {
          setContextMenu(null);
          setIsHeaderMenuOpen(false);
          setShowCreateCategory(true);
        }}
        data-group-sidebar-action="true"
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-void-text transition-colors hover:bg-void-bg-hover"
      >
        <FolderPlus className="h-4 w-4 text-void-text-muted" />
        <span>Create Category</span>
      </button>
    </>
  );

  return (
    <aside
      ref={sidebarRef}
      className="relative hidden lg:flex w-72 shrink-0 flex-col border-l border-void-bg-hover bg-void-bg-main/55 backdrop-blur-sm"
    >
      <div className="border-b border-void-bg-hover px-4 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-void-accent/15 text-void-accent">
            <Users className="h-5 w-5" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-void-text">
              {conversation.name || 'Unnamed Group'}
            </p>
            <p className="text-xs text-void-text-muted">
              Text channels
            </p>
          </div>
          {canManageChannels && (
            <div className="relative" data-group-sidebar-action="true">
              <button
                type="button"
                data-group-sidebar-action="true"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.nativeEvent.stopImmediatePropagation();
                  setContextMenu(null);
                  setIsHeaderMenuOpen((prev) => !prev);
                }}
                className="rounded-lg p-2 text-void-text-muted transition-colors hover:bg-void-bg-hover hover:text-void-text"
                title="Channel actions"
              >
                <MoreHorizontal className="h-4 w-4" />
              </button>

              {isHeaderMenuOpen && (
                <div
                  data-group-sidebar-action="true"
                  className="absolute right-0 top-full z-[250] mt-2 min-w-44 rounded-xl border border-void-bg-hover bg-void-bg-main p-1.5 shadow-2xl pointer-events-auto"
                >
                  {menuActions}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div
        className="flex-1 overflow-y-auto px-3 py-4"
        onContextMenu={handleEmptySpaceContextMenu}
      >
        <div className="flex min-h-full flex-col">
          {uncategorizedChannels.length > 0 && (
            <div className="space-y-1 pb-3">
              {uncategorizedChannels.map((channel) => (
                <GroupChannelListItem
                  key={channel.id}
                  channel={channel}
                  isActive={activeChannelId === channel.id}
                  canManage={canManageChannels}
                  onSelectChannel={onSelectChannel}
                  onOpenSettings={onOpenChannelSettings}
                />
              ))}
            </div>
          )}

          <div className="space-y-3">
            {channelCategories.map((category) => (
              <GroupChannelCategory
                key={category.id}
                category={category}
                activeChannelId={activeChannelId}
                canManageChannels={canManageChannels}
                isCollapsed={!!collapsedCategoryIds[category.id]}
                onToggleCollapse={() => toggleCategory(category.id)}
                onSelectChannel={onSelectChannel}
                onOpenChannelSettings={onOpenChannelSettings}
                onCreateChannel={openCreateChannel}
                showCreateChannelButton={category.showCreateChannelButton}
              />
            ))}
          </div>

          <div className="min-h-24 flex-1" />
        </div>
      </div>

      {canManageChannels && contextMenu && (
        <div
          data-group-sidebar-action="true"
          className="absolute z-[250] min-w-44 rounded-xl border border-void-bg-hover bg-void-bg-main p-1.5 shadow-2xl pointer-events-auto"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        >
          {menuActions}
        </div>
      )}

      {showCreateCategory && (
        <CreateCategoryModal
          groupName={conversation.name}
          existingNames={customCategories.map((category) => category.name)}
          onClose={() => setShowCreateCategory(false)}
          onCreated={handleCreateCategory}
        />
      )}
    </aside>
  );
}
