import { offset, shift } from "@floating-ui/react";
import { Fragment } from "react";
import { Palette, Plus, Repeat2, Trash2 } from "lucide-react";
import { SideMenuExtension, SuggestionMenu } from "@blocknote/core/extensions";
import {
  DragHandleMenu,
  blockTypeSelectItems,
  RemoveBlockItem,
  SideMenu,
  SideMenuController,
  TableColumnHeaderItem,
  TableRowHeaderItem,
  useBlockNoteEditor,
  useComponentsContext,
  useDictionary,
  useEditorState,
  useExtensionState,
  type SideMenuProps,
} from "@blocknote/react";
import { IdeaDragHandle } from "./IdeaDragHandle";

function TurnIntoBlock() {
  const editor = useBlockNoteEditor<any, any, any>();
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  const blockId = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block.id,
  });
  const block = useEditorState({
    editor,
    selector: ({ editor }) => (blockId ? editor.getBlock(blockId) : undefined),
  });
  // Only offer conversions that retain inline content. Files and tables need
  // their own controls rather than losing their content to a text conversion.
  if (
    !block ||
    editor.schema.blockSpecs[block.type]?.config.content !== "inline"
  )
    return null;
  const items = blockTypeSelectItems(dict).filter((item) => {
    const config = editor.schema.blockSpecs[item.type]?.config;
    return (
      config?.content === "inline" &&
      Object.entries(item.props || {}).every(([name, value]) => {
        const prop = config.propSchema[name];
        return (
          prop &&
          typeof prop.default === typeof value &&
          (!prop.values || prop.values.includes(value))
        );
      })
    );
  });
  const Menu = Components.Generic.Menu;
  return (
    <Menu.Root position="right" sub>
      <Menu.Trigger sub>
        <Menu.Item className="bn-menu-item" subTrigger>
          <Repeat2 size={16} aria-hidden="true" />
          Turn into
        </Menu.Item>
      </Menu.Trigger>
      <Menu.Dropdown sub className="bn-menu-dropdown">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <Menu.Item
              key={item.name}
              icon={<Icon size={16} aria-hidden="true" />}
              checked={
                block.type === item.type &&
                Object.entries(item.props || {}).every(
                  ([name, value]) => block.props[name] === value,
                )
              }
              onClick={() => {
                const current = editor.getBlock(block.id);
                if (current)
                  editor.updateBlock(current, {
                    type: item.type,
                    props: item.props,
                  });
              }}
            >
              {item.name}
            </Menu.Item>
          );
        })}
      </Menu.Dropdown>
    </Menu.Root>
  );
}

function LiveBlockColors() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const dict = useDictionary();
  // The side-menu extension retains the block snapshot from when it opened.
  // Use only its identity; read colour values from the current document on
  // transactions (including undo/redo and externally replaced documents).
  const blockId = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block.id,
  });
  const block = useEditorState({
    editor,
    selector: ({ editor }) => (blockId ? editor.getBlock(blockId) : undefined),
  });
  if (!block) return null;
  const sections = (["textColor", "backgroundColor"] as const).filter(
    (property) => property in block.props,
  );
  if (!sections.length) return null;
  const Menu = Components.Generic.Menu;
  return (
    <Menu.Root position="right" sub>
      <Menu.Trigger sub>
        <Menu.Item className="bn-menu-item" subTrigger>
          <Palette size={16} aria-hidden="true" />
          {dict.drag_handle.colors_menuitem}
        </Menu.Item>
      </Menu.Trigger>
      <Menu.Dropdown sub className="bn-menu-dropdown bn-color-picker-dropdown">
        {sections.map((property) => (
          <Fragment key={property}>
            <Menu.Label>
              {property === "textColor"
                ? dict.color_picker.text_title
                : dict.color_picker.background_title}
            </Menu.Label>
            {Object.entries(dict.color_picker.colors).map(([color, label]) => (
              <Menu.Item
                key={color}
                data-test={`${property === "textColor" ? "text" : "background"}-color-${color}`}
                checked={block.props[property] === color}
                onClick={() => {
                  const current = editor.getBlock(block.id);
                  if (current && property in current.props)
                    editor.updateBlock(current, {
                      props: { [property]: color },
                    });
                }}
                icon={
                  <span
                    className="bn-color-icon idea-menu-color-swatch"
                    aria-hidden="true"
                    data-text-color={
                      property === "textColor" ? color : "default"
                    }
                    data-background-color={
                      property === "backgroundColor" ? color : "default"
                    }
                  >
                    A
                  </span>
                }
              >
                {label}
              </Menu.Item>
            ))}
          </Fragment>
        ))}
      </Menu.Dropdown>
    </Menu.Root>
  );
}

function IdeaDragHandleMenu() {
  const dict = useDictionary();
  return (
    <DragHandleMenu>
      <LiveBlockColors />
      <TurnIntoBlock />
      <RemoveBlockItem>
        <span className="idea-block-delete-label">
          <Trash2 size={16} aria-hidden="true" />
          {dict.drag_handle.delete_menuitem}
        </span>
      </RemoveBlockItem>
      <TableRowHeaderItem>
        {dict.drag_handle.header_row_menuitem}
      </TableRowHeaderItem>
      <TableColumnHeaderItem>
        {dict.drag_handle.header_column_menuitem}
      </TableColumnHeaderItem>
    </DragHandleMenu>
  );
}

function AddBlockBefore() {
  const editor = useBlockNoteEditor();
  const Components = useComponentsContext()!;
  const blockId = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block.id,
  });
  if (!blockId) return null;
  return (
    <Components.SideMenu.Button
      className="bn-button"
      label="Add block before"
      icon={<Plus size={16} aria-hidden="true" />}
      onClick={() => {
        const block = editor.getBlock(blockId);
        if (!block) return;
        const target = editor.insertBlocks(
          [{ type: "paragraph" }],
          block,
          "before",
        )[0];
        editor.setTextCursorPosition(target);
        editor.focus();
        editor.getExtension(SuggestionMenu)?.openSuggestionMenu("/");
      }}
    />
  );
}

export function IdeaSideMenu(props: SideMenuProps) {
  return (
    <SideMenu {...props}>
      <AddBlockBefore />
      <IdeaDragHandle>
        <IdeaDragHandleMenu />
      </IdeaDragHandle>
    </SideMenu>
  );
}

export function IdeaSideMenuController() {
  const editor = useBlockNoteEditor();
  const block = useExtensionState(SideMenuExtension, {
    editor,
    selector: (state) => state?.block,
  });
  const question = block && ["ideaAnswer", "reviewAnswer"].includes(block.type);
  return (
    <SideMenuController
      sideMenu={IdeaSideMenu}
      floatingUIOptions={{
        useFloatingOptions: {
          middleware: [
            offset(
              question
                ? ({ rects }) => {
                    const element = editor.domElement?.querySelector(
                      `[data-id="${CSS.escape(block.id)}"]`,
                    );
                    const label = element?.querySelector<HTMLElement>(
                      ".idea-answer-section > [data-slot='collapsible-trigger'] > span",
                    );
                    if (!element || !label) return 0;
                    const lineHeight =
                      parseFloat(getComputedStyle(label).lineHeight) ||
                      label.getBoundingClientRect().height;
                    return {
                      crossAxis:
                        label.getBoundingClientRect().top -
                        element.getBoundingClientRect().top +
                        lineHeight / 2 -
                        rects.floating.height / 2,
                    };
                  }
                : 0,
            ),
            // The side menu normally lives in a desktop gutter. On a narrow
            // document that gutter can be smaller than both controls, so
            // keep the complete action surface inside the viewport.
            shift({ padding: 8, crossAxis: true }),
          ],
        },
      }}
    />
  );
}
