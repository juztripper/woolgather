/** Presentation is identical for pointer, keyboard and button-invoked menus. */
export const menuStyles = {
  composerPopup: "w-(--anchor-width) min-w-0 max-w-[calc(100vw-1rem)]",
  popup:
    "material-popup z-50 max-h-(--available-height) w-max min-w-44 max-w-[min(24rem,calc(100vw-1rem))] rounded-[18px] text-popover-foreground outline-none",
  label:
    "px-1.5 py-1 text-xs font-medium text-muted-foreground data-inset:pl-7",
  item: "group/menu-item relative flex cursor-default items-center gap-1.5 rounded-md px-2 py-1.5 text-[length:var(--text-menu)] leading-5 font-normal outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
  subTrigger:
    "flex cursor-default items-center gap-1.5 rounded-md px-2 py-1.5 text-[length:var(--text-menu)] leading-5 font-normal outline-hidden select-none focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  selectionItem:
    "relative flex cursor-default items-center gap-1.5 rounded-md py-1.5 pr-8 pl-2 text-[length:var(--text-menu)] leading-5 font-normal outline-hidden select-none focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  separator: "-mx-1 my-1 h-px bg-border",
  shortcut:
    "ml-auto text-xs tracking-widest text-muted-foreground group-focus/menu-item:text-accent-foreground",
};
