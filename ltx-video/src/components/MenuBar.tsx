import React, { useState, useRef, useEffect, useMemo } from "react";
import { Search } from "lucide-react";

// --- Types ---

export interface MenuItem {
  id: string;
  label: string;
  shortcut?: string;
  action?: () => void;
  disabled?: boolean;
  separator?: boolean; // renders a divider line
  submenu?: MenuItem[];
}

export interface MenuDefinition {
  id: string;
  label: string;
  items: MenuItem[];
}

interface MenuBarProps {
  menus: MenuDefinition[];
  rightContent?: React.ReactNode;
}

// --- Component ---

export function MenuBar({ menus, rightContent }: MenuBarProps) {
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [hoverMenuId, setHoverMenuId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [highlightedResult, setHighlightedResult] = useState(0);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // The active open menu (follow hover once a menu is open)
  const activeMenuId = openMenuId ? hoverMenuId || openMenuId : null;

  // Close menus on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        menuBarRef.current &&
        !menuBarRef.current.contains(e.target as Node)
      ) {
        setOpenMenuId(null);
        setHoverMenuId(null);
      }
    };
    if (openMenuId) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [openMenuId]);

  // Close on Escape
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpenMenuId(null);
        setHoverMenuId(null);
        setSearchQuery("");
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, []);

  // Derive search results from query + menus
  const searchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    const results: { menuLabel: string; item: MenuItem }[] = [];
    for (const menu of menus) {
      for (const item of menu.items) {
        if (item.separator) continue;
        if (item.label.toLowerCase().includes(q)) {
          results.push({ menuLabel: menu.label, item });
        }
        if (item.submenu) {
          for (const sub of item.submenu) {
            if (sub.separator) continue;
            if (sub.label.toLowerCase().includes(q)) {
              results.push({
                menuLabel: `${menu.label} > ${item.label}`,
                item: sub,
              });
            }
          }
        }
      }
    }
    return results;
  }, [searchQuery, menus]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset highlight index when query changes
    setHighlightedResult(0);
  }, [searchQuery]);

  const handleItemClick = (item: MenuItem) => {
    if (item.disabled || !item.action) return;
    item.action();
    setOpenMenuId(null);
    setHoverMenuId(null);
  };

  const handleSearchResultClick = (item: MenuItem) => {
    if (item.disabled || !item.action) return;
    item.action();
    setSearchQuery("");
    setOpenMenuId(null);
    setHoverMenuId(null);
  };

  // Handle search keyboard navigation
  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlightedResult((prev) =>
        Math.min(prev + 1, searchResults.length - 1),
      );
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlightedResult((prev) => Math.max(prev - 1, 0));
    } else if (e.key === "Enter" && searchResults[highlightedResult]) {
      e.preventDefault();
      handleSearchResultClick(searchResults[highlightedResult].item);
    }
  };

  const renderMenuItem = (item: MenuItem, index: number) => {
    if (item.separator) {
      return (
        <div key={`sep-${index}`} className="mx-2 my-1 h-px bg-zinc-700" />
      );
    }

    return (
      <button
        key={item.id}
        onClick={() => handleItemClick(item)}
        disabled={item.disabled}
        className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] transition-colors ${
          item.disabled
            ? "cursor-not-allowed text-zinc-600"
            : "text-zinc-200 hover:bg-blue-600 hover:text-white"
        }`}
      >
        <span>{item.label}</span>
        {item.shortcut && (
          <span
            className={`ml-8 text-[11px] ${item.disabled ? "text-zinc-700" : "text-zinc-500"}`}
          >
            {item.shortcut}
          </span>
        )}
      </button>
    );
  };

  return (
    <div
      ref={menuBarRef}
      className="relative z-[60] flex select-none items-center border-b border-zinc-800 bg-zinc-900"
    >
      <div className="flex flex-1 items-center">
        {menus.map((menu) => {
          const isActive = activeMenuId === menu.id;
          const isHelpMenu = menu.id === "help";

          return (
            <div key={menu.id} className="relative">
              <button
                onMouseDown={() => {
                  if (openMenuId === menu.id) {
                    setOpenMenuId(null);
                    setHoverMenuId(null);
                  } else {
                    setOpenMenuId(menu.id);
                    setHoverMenuId(null);
                    if (isHelpMenu) {
                      setTimeout(() => searchInputRef.current?.focus(), 50);
                    }
                  }
                }}
                onMouseEnter={() => {
                  if (openMenuId) setHoverMenuId(menu.id);
                }}
                className={`px-3 py-1.5 text-[13px] font-medium transition-colors ${
                  isActive
                    ? "bg-zinc-800 text-white"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {menu.label}
              </button>

              {/* Dropdown */}
              {isActive && (
                <div className="absolute left-0 top-full z-[60] min-w-[240px] rounded-b-lg border border-zinc-700 bg-zinc-900 py-1 shadow-xl shadow-black/50">
                  {/* Help menu has search */}
                  {isHelpMenu && (
                    <div className="border-b border-zinc-700 px-2 py-1.5">
                      <div className="flex items-center gap-2 rounded bg-zinc-800 px-2 py-1">
                        <Search className="h-3.5 w-3.5 flex-shrink-0 text-zinc-500" />
                        <input
                          ref={searchInputRef}
                          type="text"
                          placeholder="Search menus..."
                          value={searchQuery}
                          onChange={(e) => setSearchQuery(e.target.value)}
                          onKeyDown={handleSearchKeyDown}
                          className="flex-1 bg-transparent text-[13px] text-white placeholder-zinc-500 outline-none"
                          autoFocus
                        />
                      </div>
                      {/* Search results */}
                      {searchQuery && (
                        <div className="mt-1 max-h-48 overflow-y-auto">
                          {searchResults.length === 0 ? (
                            <div className="px-2 py-2 text-center text-[12px] text-zinc-500">
                              No results
                            </div>
                          ) : (
                            searchResults.map((result, i) => (
                              <button
                                key={`${result.item.id}-${i}`}
                                onClick={() =>
                                  handleSearchResultClick(result.item)
                                }
                                className={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-[12px] transition-colors ${
                                  i === highlightedResult
                                    ? "bg-blue-600 text-white"
                                    : "text-zinc-300 hover:bg-zinc-800"
                                }`}
                              >
                                <div>
                                  <span>{result.item.label}</span>
                                  <span className="ml-2 text-[10px] text-zinc-500">
                                    {result.menuLabel}
                                  </span>
                                </div>
                                {result.item.shortcut && (
                                  <span className="text-[10px] text-zinc-500">
                                    {result.item.shortcut}
                                  </span>
                                )}
                              </button>
                            ))
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Regular menu items */}
                  {menu.items.map((item, i) => renderMenuItem(item, i))}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {rightContent && (
        <div className="mr-2 flex items-center">{rightContent}</div>
      )}
    </div>
  );
}
